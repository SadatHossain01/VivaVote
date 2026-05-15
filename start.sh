#!/bin/bash
# ╔══════════════════════════════════════════════════════════╗
# ║  VivaVote — One-Command Start Script                    ║
# ║                                                          ║
# ║  This script starts the entire VivaVote system:          ║
# ║    1. (Optional) Hyperledger Fabric network              ║
# ║    2. API server (Express.js)                            ║
# ║    3. Frontend dev server (React + Vite)                 ║
# ║                                                          ║
# ║  USAGE:                                                  ║
# ║    ./start.sh          # Mock mode (no Docker needed)    ║
# ║    ./start.sh --fabric # Full Fabric mode                ║
# ╚══════════════════════════════════════════════════════════╝

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
FABRIC_MODE=false
PIDS_FILE="$PROJECT_DIR/.vivavote-pids"

install_node_dependencies() {
    local dir="$1"
    local label="$2"
    
    cd "$dir"
    if [ -f package-lock.json ]; then
        npm ci --no-fund --no-audit
    else
        npm install --no-fund --no-audit
    fi
    
    echo -e "  ${GREEN}✓${NC} ${label} ready"
}

kill_port_if_busy() {
    local port="$1"
    local pids
    
    if ! command -v lsof &>/dev/null; then
        return
    fi
    
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
        echo -e "  ${YELLOW}⚠${NC}  Killed leftover process on port $port"
    fi
}

# Parse arguments
for arg in "$@"; do
    case $arg in
        --fabric) FABRIC_MODE=true ;;
    esac
done

echo -e "${PURPLE}"
echo '╔══════════════════════════════════════════╗'
echo '║        🗳️  VivaVote — Starting...        ║'
echo '╚══════════════════════════════════════════╝'
echo -e "${NC}"

# ─── Check Prerequisites ────────────────────────────────
echo -e "${BLUE}📋 Checking prerequisites...${NC}"

if ! command -v node &>/dev/null; then
    echo -e "${RED}❌ Node.js not found. Please install Node.js 18+${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Node.js 18+ required (found v$(node -v))${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
    echo -e "${RED}❌ npm not found${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} npm $(npm -v)"

if [ "$FABRIC_MODE" = true ]; then
    if ! command -v docker &>/dev/null; then
        echo -e "${RED}❌ Docker not found (required for --fabric mode)${NC}"
        exit 1
    fi
    echo -e "  ${GREEN}✓${NC} Docker $(docker --version | awk '{print $3}')"
    
    if docker compose version >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} Docker Compose plugin"
        elif command -v docker-compose &>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Docker Compose"
    else
        echo -e "${RED}❌ Docker Compose not found${NC}"
        exit 1
    fi
    
    # Ensure Docker daemon is running
    if ! docker info >/dev/null 2>&1; then
        echo -e "  ${YELLOW}⚠${NC}  Docker daemon not responding — attempting to start..."
        if command -v systemctl &>/dev/null; then
            sudo systemctl start docker 2>/dev/null
            elif command -v service &>/dev/null; then
            sudo service docker start 2>/dev/null
        fi
        sleep 2
        if ! docker info >/dev/null 2>&1; then
            # May be a permissions issue — check if user is in docker group
            if ! groups | grep -qw docker; then
                echo -e "  ${YELLOW}⚠${NC}  Adding $USER to docker group..."
                sudo usermod -aG docker "$USER" 2>/dev/null
            fi
            # Try with the docker group applied to this session
            if sg docker -c "docker info" >/dev/null 2>&1; then
                echo -e "  ${YELLOW}⚠${NC}  Docker requires group permissions — restarting with 'sg docker'"
                exec sg docker -c "bash '$0' $*"
            fi
            echo -e "${RED}❌ Docker daemon is not accessible. Start Docker and try again.${NC}"
            exit 1
        fi
        echo -e "  ${GREEN}✓${NC} Docker daemon started"
    else
        echo -e "  ${GREEN}✓${NC} Docker daemon running"
    fi
    
    # Ensure fabric-nodeenv image is available (required for JS chaincode)
    if ! docker image inspect hyperledger/fabric-nodeenv:2.5 >/dev/null 2>&1; then
        echo -e "  ${YELLOW}⚠${NC}  Pulling hyperledger/fabric-nodeenv:2.5 ..."
        docker pull hyperledger/fabric-nodeenv:2.5
        echo -e "  ${GREEN}✓${NC} fabric-nodeenv:2.5 pulled"
    fi
fi

# ─── Kill leftover processes on required ports ─────────
echo -e "\n${BLUE}🧹 Cleaning up stale processes...${NC}"
if command -v lsof &>/dev/null; then
    for PORT in 4000 3000; do
        kill_port_if_busy "$PORT"
    done
else
    echo -e "  ${YELLOW}⚠${NC}  lsof not found; skipping port-based cleanup"
fi
# Also kill any tracked PIDs from a previous run
if [ -f "$PIDS_FILE" ]; then
    while read -r pid; do
        kill -9 "$pid" 2>/dev/null || true
    done < "$PIDS_FILE"
    rm -f "$PIDS_FILE"
fi

# ─── Install Dependencies ───────────────────────────────
echo -e "\n${BLUE}📦 Installing dependencies...${NC}"

echo -e "  Installing API server dependencies..."
install_node_dependencies "$PROJECT_DIR/api-server" "API server"

echo -e "  Installing frontend dependencies..."
install_node_dependencies "$PROJECT_DIR/frontend" "Frontend"

# ─── Start Fabric Network (optional) ────────────────────
if [ "$FABRIC_MODE" = true ]; then
    echo -e "\n${BLUE}🔗 Starting Hyperledger Fabric network...${NC}"
    
    # Fabric test-network scripts do not handle spaces in paths.
    # If the project path contains spaces, create a temporary symlink.
    FABRIC_PROJECT_DIR="$PROJECT_DIR"
    SYMLINK_PATH=""
    if [[ "$PROJECT_DIR" == *" "* ]] || [[ "$PROJECT_DIR" == *"("* ]]; then
        SYMLINK_PATH="/tmp/vivavote-workspace"
        rm -f "$SYMLINK_PATH"
        ln -s "$PROJECT_DIR" "$SYMLINK_PATH"
        FABRIC_PROJECT_DIR="$SYMLINK_PATH"
        echo -e "  ${YELLOW}⚠${NC}  Project path contains spaces — using symlink: $SYMLINK_PATH"
    fi
    
    FABRIC_SAMPLES="$FABRIC_PROJECT_DIR/fabric-samples"
    
    # Download Fabric samples if needed
    if [ ! -d "$FABRIC_SAMPLES" ]; then
        echo -e "  Downloading Fabric samples, binaries, and Docker images..."
        cd "$FABRIC_PROJECT_DIR"
        if [ -f "$FABRIC_PROJECT_DIR/install-fabric.sh" ]; then
            bash "$FABRIC_PROJECT_DIR/install-fabric.sh" docker samples binary
        else
            curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
            chmod +x install-fabric.sh
            ./install-fabric.sh docker samples binary
            rm -f install-fabric.sh
        fi
    fi
    
    # Start the test network
    cd "$FABRIC_SAMPLES/test-network"
    ./network.sh down 2>/dev/null || true
    ./network.sh up createChannel -c mychannel -ca
    echo -e "  ${GREEN}✓${NC} Fabric network running"
    
    # Deploy vivavote chaincode
    echo -e "  Deploying vivavote chaincode..."
    ./network.sh deployCC -ccn vivavote -ccp "$FABRIC_PROJECT_DIR/chaincode/vivavote" -ccl javascript -c mychannel
    echo -e "  ${GREEN}✓${NC} vivavote chaincode deployed"
    
    # Deploy baseline chaincode
    echo -e "  Deploying baseline chaincode..."
    ./network.sh deployCC -ccn baseline -ccp "$FABRIC_PROJECT_DIR/chaincode/baseline" -ccl javascript -c mychannel
    echo -e "  ${GREEN}✓${NC} baseline chaincode deployed"
fi

# ─── Start API Server ───────────────────────────────────
echo -e "\n${BLUE}🚀 Starting API server...${NC}"

cd "$PROJECT_DIR/api-server"
if [ "$FABRIC_MODE" = true ]; then
    FABRIC_PATH="${FABRIC_PROJECT_DIR:-$PROJECT_DIR}/fabric-samples"
    USE_FABRIC=true FABRIC_SAMPLES_PATH="$FABRIC_PATH" node src/app.js &
else
    node src/app.js &
fi
API_PID=$!
echo "$API_PID" > "$PIDS_FILE"
echo -e "  ${GREEN}✓${NC} API server started (PID: $API_PID)"

# Wait for API to be ready
echo -e "  Waiting for API server..."
for i in $(seq 1 30); do
    if curl -s http://localhost:4000/api/health >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} API server is healthy"
        break
    fi
    sleep 1
done

# ─── Start Frontend ─────────────────────────────────────
echo -e "\n${BLUE}🎨 Starting frontend dev server...${NC}"

cd "$PROJECT_DIR/frontend"
npx vite --host &
FRONTEND_PID=$!
echo "$FRONTEND_PID" >> "$PIDS_FILE"
echo -e "  ${GREEN}✓${NC} Frontend started (PID: $FRONTEND_PID)"

# ─── Done! ──────────────────────────────────────────────
sleep 2
echo -e "\n${GREEN}"
echo '╔══════════════════════════════════════════════════════╗'
echo '║              🗳️  VivaVote is Running!                ║'
echo '╠══════════════════════════════════════════════════════╣'
if [ "$FABRIC_MODE" = true ]; then
    echo '║  Mode:      🔗 Hyperledger Fabric                   ║'
else
    echo '║  Mode:      🧪 Mock (in-memory simulation)          ║'
fi
echo '║                                                      ║'
echo '║  Frontend:  http://localhost:3000                     ║'
echo '║  API:       http://localhost:4000/api                 ║'
echo '║  WebSocket: ws://localhost:4000/ws                    ║'
echo '║                                                      ║'
echo '║  Default login: admin / admin                        ║'
echo '║                                                      ║'
echo '║  Press Ctrl+C or run ./stop.sh to shut down          ║'
echo '╚══════════════════════════════════════════════════════╝'
echo -e "${NC}"

# Keep script running (catch Ctrl+C to clean up)
trap "echo -e '\n${YELLOW}Shutting down...${NC}'; bash '$PROJECT_DIR/stop.sh'; exit 0" INT TERM
wait
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
  echo -e "${RED}❌ npm not found${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} npm $(npm -v)"

if [ "$FABRIC_MODE" = true ]; then
  if ! command -v docker &>/dev/null; then
    echo -e "${RED}❌ Docker not found (required for --fabric mode)${NC}"
    exit 1
  fi
  echo -e "  ${GREEN}✓${NC} Docker $(docker --version | awk '{print $3}')"

  if docker compose version >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Docker Compose plugin"
  elif command -v docker-compose &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Docker Compose"
  else
    echo -e "${RED}❌ Docker Compose not found${NC}"
    exit 1
  fi

  # Ensure Docker daemon is running
  if ! docker info >/dev/null 2>&1; then
    echo -e "  ${YELLOW}⚠${NC}  Docker daemon not responding — attempting to start..."
    if command -v systemctl &>/dev/null; then
      sudo systemctl start docker 2>/dev/null
    elif command -v service &>/dev/null; then
      sudo service docker start 2>/dev/null
    fi
    sleep 2
    if ! docker info >/dev/null 2>&1; then
      # May be a permissions issue — check if user is in docker group
      if ! groups | grep -qw docker; then
        echo -e "  ${YELLOW}⚠${NC}  Adding $USER to docker group..."
        sudo usermod -aG docker "$USER" 2>/dev/null
      fi
      # Try with the docker group applied to this session
      if sg docker -c "docker info" >/dev/null 2>&1; then
        echo -e "  ${YELLOW}⚠${NC}  Docker requires group permissions — restarting with 'sg docker'"
        exec sg docker -c "bash '$0' $*"
      fi
      echo -e "${RED}❌ Docker daemon is not accessible. Start Docker and try again.${NC}"
      exit 1
    fi
    echo -e "  ${GREEN}✓${NC} Docker daemon started"
  else
    echo -e "  ${GREEN}✓${NC} Docker daemon running"
  fi

  # Ensure fabric-nodeenv image is available (required for JS chaincode)
  if ! docker image inspect hyperledger/fabric-nodeenv:2.5 >/dev/null 2>&1; then
    echo -e "  ${YELLOW}⚠${NC}  Pulling hyperledger/fabric-nodeenv:2.5 ..."
    docker pull hyperledger/fabric-nodeenv:2.5
    echo -e "  ${GREEN}✓${NC} fabric-nodeenv:2.5 pulled"
  fi
fi

# ─── Kill leftover processes on required ports ─────────
echo -e "\n${BLUE}🧹 Cleaning up stale processes...${NC}"
if command -v lsof &>/dev/null; then
  for PORT in 4000 3000; do
    kill_port_if_busy "$PORT"
  done
else
  echo -e "  ${YELLOW}⚠${NC}  lsof not found; skipping port-based cleanup"
fi
# Also kill any tracked PIDs from a previous run
if [ -f "$PIDS_FILE" ]; then
  while read -r pid; do
    kill -9 "$pid" 2>/dev/null || true
  done < "$PIDS_FILE"
  rm -f "$PIDS_FILE"
fi

# ─── Install Dependencies ───────────────────────────────
echo -e "\n${BLUE}📦 Installing dependencies...${NC}"

echo -e "  Installing API server dependencies..."
install_node_dependencies "$PROJECT_DIR/api-server" "API server"

echo -e "  Installing frontend dependencies..."
install_node_dependencies "$PROJECT_DIR/frontend" "Frontend"

# ─── Start Fabric Network (optional) ────────────────────
if [ "$FABRIC_MODE" = true ]; then
  echo -e "\n${BLUE}🔗 Starting Hyperledger Fabric network...${NC}"

  # Fabric test-network scripts do not handle spaces in paths.
  # If the project path contains spaces, create a temporary symlink.
  FABRIC_PROJECT_DIR="$PROJECT_DIR"
  SYMLINK_PATH=""
  if [[ "$PROJECT_DIR" == *" "* ]] || [[ "$PROJECT_DIR" == *"("* ]]; then
    SYMLINK_PATH="/tmp/vivavote-workspace"
    rm -f "$SYMLINK_PATH"
    ln -s "$PROJECT_DIR" "$SYMLINK_PATH"
    FABRIC_PROJECT_DIR="$SYMLINK_PATH"
    echo -e "  ${YELLOW}⚠${NC}  Project path contains spaces — using symlink: $SYMLINK_PATH"
  fi

  FABRIC_SAMPLES="$FABRIC_PROJECT_DIR/fabric-samples"

  # Download Fabric samples if needed
  if [ ! -d "$FABRIC_SAMPLES" ]; then
    echo -e "  Downloading Fabric samples, binaries, and Docker images..."
    cd "$FABRIC_PROJECT_DIR"
    if [ -f "$FABRIC_PROJECT_DIR/install-fabric.sh" ]; then
      bash "$FABRIC_PROJECT_DIR/install-fabric.sh" docker samples binary
    else
      curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
      chmod +x install-fabric.sh
      ./install-fabric.sh docker samples binary
      rm -f install-fabric.sh
    fi
  fi

  # Start the test network
  cd "$FABRIC_SAMPLES/test-network"
  ./network.sh down 2>/dev/null || true
  ./network.sh up createChannel -c mychannel -ca
  echo -e "  ${GREEN}✓${NC} Fabric network running"

  # Deploy vivavote chaincode
  echo -e "  Deploying vivavote chaincode..."
  ./network.sh deployCC -ccn vivavote -ccp "$FABRIC_PROJECT_DIR/chaincode/vivavote" -ccl javascript -c mychannel
  echo -e "  ${GREEN}✓${NC} vivavote chaincode deployed"

  # Deploy baseline chaincode
  echo -e "  Deploying baseline chaincode..."
  ./network.sh deployCC -ccn baseline -ccp "$FABRIC_PROJECT_DIR/chaincode/baseline" -ccl javascript -c mychannel
  echo -e "  ${GREEN}✓${NC} baseline chaincode deployed"
fi

# ─── Start API Server ───────────────────────────────────
echo -e "\n${BLUE}🚀 Starting API server...${NC}"

cd "$PROJECT_DIR/api-server"
if [ "$FABRIC_MODE" = true ]; then
  FABRIC_PATH="${FABRIC_PROJECT_DIR:-$PROJECT_DIR}/fabric-samples"
  USE_FABRIC=true FABRIC_SAMPLES_PATH="$FABRIC_PATH" node src/app.js &
else
  node src/app.js &
fi
API_PID=$!
echo "$API_PID" > "$PIDS_FILE"
echo -e "  ${GREEN}✓${NC} API server started (PID: $API_PID)"

# Wait for API to be ready
echo -e "  Waiting for API server..."
for i in $(seq 1 30); do
  if curl -s http://localhost:4000/api/health >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} API server is healthy"
    break
  fi
  sleep 1
done

# ─── Start Frontend ─────────────────────────────────────
echo -e "\n${BLUE}🎨 Starting frontend dev server...${NC}"

cd "$PROJECT_DIR/frontend"
npx vite --host &
FRONTEND_PID=$!
echo "$FRONTEND_PID" >> "$PIDS_FILE"
echo -e "  ${GREEN}✓${NC} Frontend started (PID: $FRONTEND_PID)"

# ─── Done! ──────────────────────────────────────────────
sleep 2
echo -e "\n${GREEN}"
echo '╔══════════════════════════════════════════════════════╗'
echo '║              🗳️  VivaVote is Running!                ║'
echo '╠══════════════════════════════════════════════════════╣'
if [ "$FABRIC_MODE" = true ]; then
echo '║  Mode:      🔗 Hyperledger Fabric                   ║'
else
echo '║  Mode:      🧪 Mock (in-memory simulation)          ║'
fi
echo '║                                                      ║'
echo '║  Frontend:  http://localhost:3000                     ║'
echo '║  API:       http://localhost:4000/api                 ║'
echo '║  WebSocket: ws://localhost:4000/ws                    ║'
echo '║                                                      ║'
echo '║  Default login: admin / admin                        ║'
echo '║                                                      ║'
echo '║  Press Ctrl+C or run ./stop.sh to shut down          ║'
echo '╚══════════════════════════════════════════════════════╝'
echo -e "${NC}"

# Keep script running (catch Ctrl+C to clean up)
trap "echo -e '\n${YELLOW}Shutting down...${NC}'; bash '$PROJECT_DIR/stop.sh'; exit 0" INT TERM
wait
