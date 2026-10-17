import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// No StrictMode: its double effects would exchange the OAuth code twice and create two SDK players.
createRoot(document.getElementById('root')!).render(<App />)
