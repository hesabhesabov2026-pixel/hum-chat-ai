
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

const SYSTEM_PROMPT =
  "Sən Hüm Chat AI adlı mehriban köməkçisən. " +
  "Azərbaycan dilində aydın, faydalı və səmimi cavab ver.";

// API-dən real modelləri alırıq.
// Yalnız generateContent dəstəkləyən modellər seçilir.
async function getModels(apiKey) {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models",
    {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(15000)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || "Modellərin siyahısı alınmadı."
    );
  }

  return (data.models || [])
    .filter(model =>
      model.supportedGenerationMethods?.includes("generateContent")
    )
    .map(model => model.name.replace(/^models\//, ""));
}

// Serverin vəziyyəti
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    message: "Hüm Chat AI serveri işləyir!"
  });
});

// Hesabın əlçatan modelləri
app.get("/api/models", async (req, res) => {
  try {
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
  } catch (error) {
    console.error("Model siyahısı xətası:", error.message);

    res.status(502).json({
      error: "Modelləri almaq mümkün olmadı."
    });
  }
});

// Mesaj və ya şəkil göndərmək
app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body?.message;
    const image = req.body?.image;
    const mimeType = req.body?.mimeType;

    if (
      typeof message !== "string" ||
      (!message.trim() && !image)
    ) {
      return res.status(400).json({
        error: "Mesaj yaz və ya şəkil göndər."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY Render-də qurulmayıb."
      });
    }

    const parts = [];

    if (message.trim()) {
      parts.push({ text: message.trim() });
    }

    if (image) {
      if (
        typeof image !== "string" ||
        !["image/jpeg", "image/png", "image/webp"].includes(mimeType)
      ) {
        return res.status(400).json({
          error: "JPG, PNG və ya WEBP şəkli göndər."
        });
      }

      if (image.length > 8 * 1024 * 1024) {
        return res.status(413).json({
          error: "Şəkil çox böyükdür. Daha kiçik şəkil seç."
        });
      }

      // Frontend şəkli base64 kimi göndərməlidir.
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: image
        }
      });
    }

    if (!message.trim() && image) {
      parts.unshift({
        text: "Bu şəkli təhlil et və Azərbaycan dilində izah et."
      });
    }

    // Əsas model əvvəl yoxlanılır.
    // Sonra API-dən alınmış digər modellər sınanır.
    const availableModels = await getModels(apiKey);

    const preferredModels = [
      "gemini-3.8-flash"
    ];

    const modelList = [
      ...preferredModels.filter(m => availableModels.includes(m)),
      ...availableModels.filter(m => m !== "gemini-3.8-flash")
    ];

    if (modelList.length === 0) {
      return res.status(502).json({
        error: "API hesabında uyğun model tapılmadı."
      });
    }

    let lastStatus = 502;

    for (const model of modelList) {
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
              contents: [{
                role: "user",
                parts
              }]
            }),
            signal: AbortSignal.timeout(30000)
          }
        );

        const data = await response.json();

        if (!response.ok) {
          lastStatus = response.status;

          console.error(
            `Model ${model}:`,
            response.status,
            data.error?.message || ""
          );

          // Limit, müvəqqəti xəta və model əlçatanlığı
          // problemlərində növbəti modeli yoxla.
          if ([400, 403, 404, 429].includes(response.status) ||
              response.status >= 500) {
            continue;
          }

          return res.status(502).json({
            error: "AI xidmətində xəta baş verdi."
          });
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

        lastStatus = 502;
      } catch (error) {
        console.error(`${model}:`, error.message);
      }
    }

    return res.status(502).json({
      error: "Bütün yoxlanmış modellər cavab vermədi. Bir az sonra yenidən yoxla.",
      status: lastStatus
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
