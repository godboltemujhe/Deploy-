# BMV Quiz App - Deployment Guide

This guide provides instructions for deploying the BMV Quiz App to various environments.

## File Structure

The deployable application consists of the following key files:

- `dist/public/index.html`: The main HTML file
- `dist/public/assets/index-*.js`: The compiled JavaScript bundle
- `dist/public/assets/index-*.css`: The compiled CSS styles
- `dist/public/service-worker.js`: Service worker for offline functionality
- `dist/public/manifest.json`: Web app manifest for PWA features
- `dist/public/offline.html`: Offline fallback page
- `dist/public/icons/`: Directory containing app icons
- `dist/index.js`: Server-side Node.js code
- `server.js`: Simplified server for easy deployment

## Deployment Options

### Option 1: Deploy as a Static Site

The app can be deployed as a static site to platforms like Netlify, Vercel, GitHub Pages, or any static hosting service.

1. Upload the entire contents of the `dist/public` directory to your web hosting service.
2. Configure your hosting service to redirect all routes to `index.html` for the client-side routing to work.

### Option 2: Deploy with Node.js Server

For platforms that support Node.js (Heroku, Render, DigitalOcean, etc.):

1. Upload the `deployable-app.zip` file to your server and extract it.
2. Install Node.js dependencies:
   ```
   npm install express
   ```
3. Start the server:
   ```
   node server.js
   ```

### Option 3: Deploy with Docker

1. Create a Dockerfile in the same directory as the extracted `deployable-app.zip`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY dist/ ./dist/
COPY server.js ./

RUN npm init -y && npm install express

EXPOSE 5000

CMD ["node", "server.js"]
```

2. Build and run the Docker container:
```
docker build -t bmv-quiz .
docker run -p 5000:5000 bmv-quiz
```

## PWA Features

The BMV Quiz App is built as a Progressive Web App (PWA) with the following features:

- **Offline Support**: The app works offline thanks to the service worker
- **Installable**: Users can install the app on their devices
- **Responsive Design**: Works on all screen sizes

## Database Considerations

This app uses client-side storage (localStorage) for persistency. If you need server-side database storage:

1. Set up a PostgreSQL database
2. Modify the server to connect to the database
3. Update the API endpoints in the server to read/write to the database

For basic deployments, no database setup is required as the app functions fully with client-side storage.

## Additional Notes

- The app is configured to run on port 5000 by default. You can change this by setting the `PORT` environment variable.
- For production deployments, consider adding HTTPS for enhanced security.