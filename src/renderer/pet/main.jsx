import { createRoot } from 'react-dom/client';
import Pet from './Pet.jsx';
import '../styles/base.css';
import './pet.css';

if (!window.bun?.isElectron) document.body.classList.add('pet-preview');

createRoot(document.getElementById('pet-root')).render(<Pet />);
