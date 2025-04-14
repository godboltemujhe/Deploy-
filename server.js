// Simple Express server for BMV Quiz App
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Serve static files from the dist/public directory
app.use(express.static(path.join(__dirname, 'dist/public')));

// API routes
app.get('/api/quizzes', (req, res) => {
  // Return an empty array initially (data will be stored in localStorage)
  res.json([]);
});

// Fallback route: Serve index.html for any request not handled above
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist/public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});