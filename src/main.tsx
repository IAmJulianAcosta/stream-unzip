import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ZipDownloader from './ZipDownloader.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ZipDownloader zipUrl={zipUrl} />
  </StrictMode>,
)
