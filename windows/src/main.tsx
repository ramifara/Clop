import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CompareWindow } from './CompareWindow';
import { CropWindow } from './CropWindow';
import './style.css';
const query = new URLSearchParams(location.search), crop = query.get('crop'), compare = query.get('compare');
createRoot(document.getElementById('root')!).render(<React.StrictMode>{crop ? <CropWindow id={crop}/> : compare ? <CompareWindow id={compare}/> : <App/>}</React.StrictMode>);
