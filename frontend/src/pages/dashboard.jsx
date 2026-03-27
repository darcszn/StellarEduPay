import { useState, useEffect } from 'react';
import Navbar from '../components/Navbar';
import SyncButton from '../components/SyncButton';
import { getSyncStatus } from '../services/api';

function timeAgo(isoString) {
  if (!isoString) return 'Never';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  return new Date(isoString).toLocaleString();
}

export default function Dashboard() {
  const [lastSyncAt, setLastSyncAt]   = useState(null);
  const [syncMessage, setSyncMessage] = useState(null);

  useEffect(() => {
    getSyncStatus()
      .then(({ data }) => setLastSyncAt(data.lastSyncAt))
      .catch(() => {});
  }, []);

  function handleSyncComplete(data) {
    setLastSyncAt(new Date().toISOString());
    setSyncMessage(data?.message || 'Sync complete.');
  }

  return (
    <>
      <Navbar />
      <div style={{ maxWidth: 800, margin: '2rem auto', fontFamily: 'sans-serif', padding: '0 1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <h1 style={{ margin: 0 }}>Admin Dashboard</h1>
          <SyncButton onSyncComplete={handleSyncComplete} lastSyncTime={lastSyncAt} />
        </div>

        {syncMessage && (
          <p style={{ color: '#2e7d32', background: '#f1f8e9', padding: '0.6rem 1rem', borderRadius: 6, fontSize: '0.9rem' }}
             role="status">
            ✓ {syncMessage}
          </p>
        )}

        <p style={{ fontSize: '0.85rem', color: '#888' }}>
          Last synced: <strong>{timeAgo(lastSyncAt)}</strong>
        </p>
      </div>
    </>
  );
}
