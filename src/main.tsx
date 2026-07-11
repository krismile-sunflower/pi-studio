import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './style.css';
import './workbench.css';
import { App } from './app/App';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(<App />);
