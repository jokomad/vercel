const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Current Time</title>
      <style>
        body {
          margin: 0;
          height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          font-family: Arial, sans-serif;
          background-color: #f0f0f0;
        }
        #time {
          font-size: 4rem;
          font-weight: bold;
          color: #333;
        }
      </style>
    </head>
    <body>
      <div id="time"></div>
      <script>
        function updateTime() {
          const now = new Date();
          const time = now.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          });
          document.getElementById('time').textContent = time;
        }
        updateTime();
        setInterval(updateTime, 1000);
      </script>
    </body>
    </html>
  `);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});