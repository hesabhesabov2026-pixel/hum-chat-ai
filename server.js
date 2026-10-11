const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Şəkil və böyük məlumatlar üçün limit 50MB edilib
app.use(express.json({ limit: "50mb" }));
app.use(express.static(__dirname));

const SYSTEM_PROMPT =
  "Sən Hüm Chat AI adlı mehriban və ağıllı köməkçisən. " +
  "Azərbaycan dilində aydın, dəqiq, faydalı və səmimi cavab ver. Şəkilləri təhlil edərkən detallı izah et.";

// API-dən real modelləri avtomatik çəkən funksiya
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
      return getFallbackModels();
    }

    const fetchedModels = (data.models || [])
      .filter(model =>
        model.supportedGenerationMethods?.includes("generateContent")
      )
      .map(model => model.name.replace(/^models\//, ""));

    return fetchedModels.length > 0 ? fetchedModels : getFallbackModels();
  } catch (err) {
    return getFallbackModels();
  }
}

// Genişləndirilmiş YZ (AI) modelləri siyahısı (Ehtiyat mexanizmi üçün)
function getFallbackModels() {
  return [
    "gemini-3.8-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash-8b",
    "gemini-2.0-flash-lite",
    "gemini-pro",
    "gemini-pro-vision"
  ];
}

// Serverin vəziyyəti
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    message: "Hüm Chat AI serveri işləyir!"
  });
});

// Əlçatan YZ modellərinin siyahısı
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
    res.status(502).json({
      error: "Modelləri almaq mümkün olmadı."
    });
  }
});

// Mesaj və ya Şəkil ilə Təhlil Sorğusu
app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body?.message;
    const image = req.body?.image; // Base64 formatında şəkil
    const mimeType = req.body?.mimeType;

    if (
      typeof message !== "string" ||
      (!message.trim() && !image)
    ) {
      return res.status(400).json({
        error: "Zəhmət olmasa mesaj yazın və ya şəkil göndərin."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY Render-də qurulmayıb."
      });
    }

    const parts = [];

    if (message && message.trim()) {
      parts.push({ text: message.trim() });
    }

    // Şəkil dəstəyi və yoxlanışı
    if (image) {
      if (
        typeof image !== "string" ||
        !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)
      ) {
        return res.status(400).json({
          error: "Dəstəklənməyən şəkil formatı (Yalnız JPG, PNG, WEBP, GIF qəbul olunur)."
        });
      }

      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: image
        }
      });
    }

    // Əgər istifadəçi yalnız şəkil göndərilibsə, avtomatik təhlil əmri əlavə edilir
    if (!message || (!message.trim() && image)) {
      parts.unshift({
        text: "Bu şəkli diqqətlə təhlil et və gördüklərini Azərbaycan dilində ətraflı izah et."
      });
    }

    const availableModels = await getModels(apiKey);

    // Əsas üstünlük verilən YZ modelləri sırası
    const preferredModels = [
      "gemini-3.8-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
      "gemini-1.5-pro",
      "gemini-1.5-flash-8b",
      "gemini-2.0-flash-lite"
    ];

    const modelList = [
      ...preferredModels.filter(m => availableModels.includes(m)),
      ...availableModels.filter(m => !preferredModels.includes(m))
    ];

    let lastStatus = 502;

    // Modelləri ardıcıl yoxlayaraq cavab almağa çalışırıq
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
            signal: AbortSignal.timeout(35000)
          }
        );

        const data = await response.json();

        if (!response.ok) {
          lastStatus = response.status;
          console.error(`Model [${model}] xətası:`, response.status, data.error?.message || "");

          // Limit (429) və ya digər xətalarda avtomatik növbəti modelə keçir
          if ([400, 403, 404, 429].includes(response.status) || response.status >= 500) {
            continue;
          }
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
      } catch (error) {
        console.error(`Model [${model}] sorğu xətası:`, error.message);
      }
    }

    return res.status(502).json({
      error: "Bütün YZ modelləri limitdədir və ya cavab vermədi. Bir az sonra yenidən yoxlayın.",
      status: lastStatus
    });
  } catch (error) {
    console.error("Server xətası:", error.message);
    return res.status(500).json({
      error: "Serverdə gözlənilməz xəta baş verdi."
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hüm Chat AI serveri ${PORT} portunda işləyir.`);
});
