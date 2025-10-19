{
  "functions": {
    "api/**/*.js": {
      "runtime": "nodejs20.x"
    }
  },
  "crons": [
    {
      "path": "/api/guardian",
      "schedule": "* * * * *"
    }
  ]
}
