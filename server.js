const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Əsas səhifə
app.get('/', (req, res) => {
  res.send('Hum Chat AI Server işləyir!');
});

// Bütün digər tapılmayan route-lar üçün (Express 5 uyğun)
app.use((req, res) => {
  res.status(404).send('Səhifə tapılmadı');
});

app.listen(PORT, () => {
  console.log(`Server ${PORT} portunda çalışır`);
});
