
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    message: "Hüm Chat AI serveri işləyir!"
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body?.message;

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: "Mesaj yazmalısan."
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Gemini API açarı Render-də qurulmayıb."
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "Sən Hüm Chat AI adlı mehriban köməkçisən. İstifadəçiyə Azərbaycan dilində aydın və faydalı cavab ver."
            }]
          },
          contents: [{
            role: "user",
            parts: [{
              text: message.trim()
            }]
          }]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API xətası:", response.status, data);

      return res.status(502).json({
        error: "AI cavab verə bilmədi. Render Logs bölməsindəki xətanı yoxla."
      });
    }

    const answer = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    return res.json({
      answer: answer || "AI hazırda cavab qaytarmadı."
    });

  } catch (error) {
    console.error("Server xətası:", error.message);

    return res.status(500).json({
      error: "Serverdə xəta baş verdi."
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hüm Chat AI serveri ${PORT} portunda işləyir.`);
});
