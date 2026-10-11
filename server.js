
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.static(__dirname));

const SYSTEM_PROMPT =
  "Sən Hüm Chat AI adlı mehriban və ağıllı köməkçisən. " +
  "Azərbaycan dilində aydın, dəqiq, faydalı və səmimi cavab ver. " +
  "Şəkilləri təhlil edərkən detallı izah et. " +
  "Əvvəlki mesajları nəzərə al və eyni söhbətdə verilən suallara uyğun cavab ver. " +
  "İstifadəçinin əvvəlki mesajlarını yeni faktlarla qarışdırma.";

// Ehtiyat modellər
function getFallbackModels() {
  return [
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash-8b",
    "gemini-2.0-flash-lite",
    "gemini-pro"
  ];
}

// Gemini API-dən mövcud modelləri al
async function getModels(apiKey) {
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models",
      {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(15000)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Model siyahısı xətası:", data.error?.message);
      return getFallbackModels();
    }

    const models = (data.models || [])
      .filter(model =>
        model.supportedGenerationMethods?.includes("generateContent")
      )
      .map(model => model.name.replace(/^models\//, ""));

    return models.length ? models : getFallbackModels();
  } catch (error) {
    console.error("Model siyahısını almaq olmadı:", error.message);
    return getFallbackModels();
  }
}

// Server statusu
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    message: "Hüm Chat AI serveri işləyir!"
  });
});

// Mövcud modellər
app.get("/api/models", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY Render-də qurulmayıb."
    });
  }

  const models = await getModels(apiKey);

  res.json({
    success: true,
    count: models.length,
    models
  });
});

// Yeni söhbət yaddaşı dəstəyi ilə AI
app.post("/api/chat", async (req, res) => {
  try {
    const {
      message,
      image,
      mimeType,
      history
    } = req.body || {};

    if (
      typeof message !== "string" ||
      (!message.trim() && !image)
    ) {
      return res.status(400).json({
        error: "Mesaj yazın və ya şəkil göndərin."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY Render-də qurulmayıb."
      });
    }

    // Əvvəlki yazışmaları yoxla.
    // history yalnız əvvəlki mesajları ehtiva etməlidir.
    const safeHistory = Array.isArray(history)
      ? history
          .filter(item =>
            item &&
            ["user", "model"].includes(item.role) &&
            typeof item.text === "string" &&
            item.text.trim().length > 0
          )
          .slice(-20)
          .map(item => ({
            role: item.role,
            parts: [{ text: item.text.slice(0, 12000) }]
          }))
      : [];

    // Cari mesajın hissələri
    const currentParts = [];

    if (message.trim()) {
      currentParts.push({
        text: message.trim()
      });
    }

    // Şəkil yoxlanışı
    if (image) {
      const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif"
      ];

      if (
        typeof image !== "string" ||
        !allowedTypes.includes(mimeType)
      ) {
        return res.status(400).json({
          error: "Yalnız JPG, PNG, WEBP və GIF şəkilləri qəbul olunur."
        });
      }

      currentParts.push({
        inline_data: {
          mime_type: mimeType,
          data: image
        }
      });
    }

    // Şəkil tək göndəriləndə
    if (!message.trim() && image) {
      currentParts.unshift({
        text: "Bu şəkli diqqətlə təhlil et və gördüklərini Azərbaycan dilində izah et."
      });
    }

    // Tarixçə + cari mesaj
    const contents = [
      ...safeHistory,
      {
        role: "user",
        parts: currentParts
      }
    ];

    const availableModels = await getModels(apiKey);

    const preferredModels = [
      "gemini-3.8-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
      "gemini-1.5-pro",
      "gemini-1.5-flash-8b",
      "gemini-2.0-flash-lite"
    ];

    const modelList = [
      ...preferredModels.filter(model =>
        availableModels.includes(model)
      ),
      ...availableModels.filter(model =>
        !preferredModels.includes(model)
      )
    ];

    let lastStatus = 502;
    let lastError = "";

    for (const model of [...new Set(modelList)]) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }]
              },
              contents,
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 4096
              }
            }),
            signal: AbortSignal.timeout(35000)
          }
        );

        const data = await response.json();

        if (!response.ok) {
          lastStatus = response.status;
          lastError = data.error?.message || "";

          console.error(
            `Model ${model} xətası:`,
            response.status,
            lastError
          );

          continue;
        }

        const answer = data.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("")
          .trim();

        if (answer) {
          return res.json({
            success: true,
            answer,
            model
          });
        }

        lastError = "Model boş cavab qaytardı.";
      } catch (error) {
        lastError = error.message;
        console.error(`Model ${model}:`, error.message);
      }
    }

    return res.status(502).json({
      error: "AI cavab vermədi. API açarını, model siyahısını və limitləri yoxla.",
      status: lastStatus
    });

  } catch (error) {
    console.error("Server xətası:", error);

    return res.status(500).json({
      error: "Serverdə gözlənilməz xəta baş verdi."
    });
  }
});

// Əsas səhifə
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hüm Chat AI ${PORT} portunda işləyir.`);
});
