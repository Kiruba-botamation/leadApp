# Lead App

This is a Node.js/Express application for managing leads with SSO authentication.

## Installation

```bash
npm install
```

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```
PORT=8083
MONGODB_URI=mongodb://localhost:27017/leadapp
ALLOWED_ORIGINS=http://localhost:3000
NODE_ENV=development
AUTH_SERVICE_URL=http://localhost:8081
FRONTEND_BASE_URL=http://localhost:3000
```

## Running the Application

```bash
npm start
```

Or with nodemon for development:

```bash
npm run dev
```

## API Endpoints

### Leads
- `POST /api/leads` - Create new lead(s)
- `GET /api/leads` - Get all leads with pagination

### Analytics
- `GET /api/analytics/chart-data` - Get chart data with grouping and aggregation

### SSO/Auth
- `GET /api/sso/...` - SSO authentication endpoints
- `GET /login` - SSO login redirect
