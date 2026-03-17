# Mixed Tasks

A realistic workflow combining agent instructions and inline CLI commands.

## Setup

- [x] cli: npm init -y
- [x] cli: npm install express

## Implementation

- [ ] Create a minimal Express server in `server.js` that responds with "ok" on GET /health
- [ ] cli: node -e "const http = require('http'); http.get('http://localhost:3000/health', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{console.log(d);process.exit(d==='ok'?0:1)})})"

## Documentation

- [ ] Write a short README explaining how to start and test the server
- [ ] Add inline code examples to the README
