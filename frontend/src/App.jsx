import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Home from './pages/Home';
import Login from './pages/Login';
import ElectionList from './pages/ElectionList';
import CreateElection from './pages/CreateElection';
import VotingBooth from './pages/VotingBooth';
import Results from './pages/Results';
import AdminDashboard from './pages/AdminDashboard';
import TrusteeDashboard from './pages/TrusteeDashboard';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? children : <Navigate to="/login" />;
}

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />

        <Route path="/elections" element={<ProtectedRoute><ElectionList /></ProtectedRoute>} />
        <Route path="/create" element={<ProtectedRoute><CreateElection /></ProtectedRoute>} />
        <Route path="/elections/:id" element={<ProtectedRoute><VotingBooth /></ProtectedRoute>} />
        <Route path="/elections/:id/results" element={<ProtectedRoute><Results /></ProtectedRoute>} />
        <Route path="/admin" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
        <Route path="/admin/:id" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
        <Route path="/trustee" element={<ProtectedRoute><TrusteeDashboard /></ProtectedRoute>} />
        <Route path="/trustee/:id" element={<ProtectedRoute><TrusteeDashboard /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
}
