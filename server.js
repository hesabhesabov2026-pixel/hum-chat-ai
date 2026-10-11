
const express = require("express");
const path = require("path");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

// JSON mesajları üçün
app.use(express.json({ limit: "50mb" }));

// Şəkil yükləmə sistemi
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // Maksimum 10 MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif"
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Yalnız JPG, PNG, WEBP və GIF şəkilləri qəbul olunur."));
    }
  }
});

// HTML, CSS və digər statik fayllar
app.use(express.static(__dirname));

const SYSTEM_PROMPT =
  "Sən Hüm Chat AI adlı mehriban və ağıllı köməkçisən. " +
  "Azərbaycan dilində aydın, dəqiq, faydalı və səmimi cavab ver. " +
  "Şəkilləri təhlil edərkən gördüklərini diqqətlə izah et. " +
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
        headers: {
          "x-goog-api-key": apiKey
        },
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

// AI söhbəti: mətn + şəkil + əvvəlki mesajlar
app.post("/api/chat", upload.single("image"), async (req, res) => {
  try {
    const message =
      typeof req.body.message === "string"
        ? req.body.message
        : "";

    let history = req.body.history;
    let image = req.body.image || null;
    let mimeType = req.body.mimeType || null;

    // FormData ilə göndərilən şəkli base64 formatına çevir
    if (req.file) {
      image = req.file.buffer.toString("base64");
      mimeType = req.file.mimetype;
    }

    // FormData-da history mətn kimi gələ bilər
    if (typeof history === "string") {
      try {
        history = JSON.parse(history);
      } catch {
        history = [];
      }
    }

    if (!message.trim() && !image) {
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

    // Əvvəlki mesajları yoxla
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
            parts: [
              { text: item.text.slice(0, 12000) }
            ]
          }))
      : [];

    // Cari mesajın hissələri
    const currentParts = [];

    if (message.trim()) {
      currentParts.push({
        text: message.trim()
      });
    }

    // Şəkli yoxla
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

      // Data URL göndərilibsə, yalnız base64 hissəsini götür
      const base64Image = image.replace(
        /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
        ""
      );

      currentParts.push({
        inline_data: {
          mime_type: mimeType,
          data: base64Image
        }
      });
    }

    // İstifadəçi yalnız şəkil göndəribsə
    if (!message.trim() && image) {
      currentParts.unshift({
        text: "Bu şəkli diqqətlə təhlil et və gördüklərini Azərbaycan dilində izah et."
      });
    }

    // Tarixçə və cari mesaj
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

    // Mövcud modelləri növbə ilə yoxla
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

    console.error("Bütün modellər uğursuz oldu:", lastError);

    return res.status(502).json({
      error: "AI cavab vermədi. API açarını, modelləri və limitləri yoxla.",
      status: lastStatus
    });

  } catch (error) {
    console.error("Server xətası:", error);

    return res.status(500).json({
      error: "Serverdə gözlənilməz xəta baş verdi."
    });
  }
});

// Şəkil yükləmə və digər middleware xətaları
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "Şəkil çox böyükdür. Maksimum ölçü 10 MB-dır."
      });
    }

    return res.status(400).json({
      error: "Şəkil yüklənərkən xəta baş verdi."
    });
  }

  if (err) {
    return res.status(400).json({
      error: err.message || "Sorğu emal edilə bilmədi."
    });
  }

  next();
});

// Əsas səhifə
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Serveri başladır
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hüm Chat AI ${PORT} portunda işləyir.`);
});
