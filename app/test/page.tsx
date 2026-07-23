export default function TestPage() {
  return (
    <div style={{ padding: '50px', color: 'white', background: '#0A0E1A', minHeight: '100vh' }}>
      <h1>Test Page</h1>
      <p>If you can see this, the layout is working.</p>
      <p>Current time: {new Date().toISOString()}</p>
    </div>
  )
}



