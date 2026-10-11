
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "15mb" }));
app.use(express.static(__dirname));

const SYSTEM_PROMPT =
  "Sən Hüm Chat AI adlı mehriban və ağıllı köməkçisən. " +
  "Azərbaycan dilində aydın, dəqiq, faydalı və səmimi cavab ver. " +
  "Şəkilləri diqqətlə təhlil et və gördüklərini izah et. " +
  "Əvvəlki mesajları nəzərə al və söhbətin məntiqi davamını qoru. " +
  "Əvvəlki mesajlarda olmayan məlumatları uydurma.";

// Əvvəlcə bu modellər yoxlanılır.
// Server yalnız API-də mövcud olanları seçir.
const PREFERRED_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash-8b",
  "gemini-pro"
];

const MAX_MODEL_ATTEMPTS = 6;
const MODEL_CACHE_TTL = 5 * 60 * 1000;

let modelCache = {
  models: [],
  expiresAt: 0
};

let modelsRequestPromise = null;

function getFallbackModels() {
  return [...PREFERRED_MODELS];
}

// Gemini modellərinin siyahısını keşlə al
async function getModels(apiKey) {
  if (
    modelCache.models.length &&
    Date.now() < modelCache.expiresAt
  ) {
    return modelCache.models;
  }

  // Eyni anda gələn sorğular təkrar model siyahısı istəməsin
  if (modelsRequestPromise) {
    return modelsRequestPromise;
  }

  modelsRequestPromise = (async () => {
    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models",
        {
          headers: {
            "x-goog-api-key": apiKey
          },
          signal: AbortSignal.timeout(10000)
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error(
          "Model siyahısı xətası:",
          response.status,
          data.error?.message || ""
        );

        // API açarı səhvdirsə ehtiyat modellərə keçmək faydasızdır
        if ([400, 401, 403].includes(response.status)) {
          return [];
        }

        return getFallbackModels();
      }

      const models = (data.models || [])
        .filter(model =>
          model.supportedGenerationMethods?.includes(
            "generateContent"
          )
        )
        .map(model =>
          model.name.replace(/^models\//, "")
        );

      const uniqueModels = [...new Set(models)];

      if (!uniqueModels.length) {
        return getFallbackModels();
      }

      modelCache = {
        models: uniqueModels,
        expiresAt: Date.now() + MODEL_CACHE_TTL
      };

      return uniqueModels;
    } catch (error) {
      console.error(
        "Model siyahısını almaq olmadı:",
        error.message
      );

      return getFallbackModels();
    } finally {
      modelsRequestPromise = null;
    }
  })();

  return modelsRequestPromise;
}

// Status
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

  if (!models.length) {
    return res.status(502).json({
      error: "Modellərin siyahısını almaq olmadı."
    });
  }

  res.json({
    success: true,
    count: models.length,
    models
  });
});

// AI söhbəti: mətn, şəkil, tarixçə və avtomatik model keçidi
app.post("/api/chat", async (req, res) => {
  try {
    const body = req.body || {};

    const message =
      typeof body.message === "string"
        ? body.message
        : "";

    let image = body.image || null;
    let mimeType = body.mimeType || null;
    const history = body.history;

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

    // Data URL göndərilərsə base64 hissəsini ayır
    if (typeof image === "string" && image.startsWith("data:")) {
      const match = image.match(
        /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/
      );

      if (!match) {
        return res.status(400).json({
          error: "Şəklin formatı düzgün deyil."
        });
      }

      mimeType = mimeType || match[1];
      image = match[2];
    }

    // Şəkil yoxlamaları
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
          error: "Yalnız JPG, PNG, WEBP və GIF qəbul olunur."
        });
      }

      if (
        image.length === 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(image) ||
        image.length % 4 !== 0
      ) {
        return res.status(400).json({
          error: "Şəkil məlumatı düzgün deyil."
        });
      }

      const imageBytes = Buffer.from(image, "base64");

      if (
        imageBytes.length === 0 ||
        imageBytes.length > 8 * 1024 * 1024
      ) {
        return res.status(413).json({
          error: "Şəkil 8 MB-dan böyük ola bilməz."
        });
      }
    }

    // Tarixçəni təhlükəsiz şəkildə hazırla
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
              {
                text: item.text.slice(0, 12000)
              }
            ]
          }))
      : [];

    const currentParts = [];

    if (message.trim()) {
      currentParts.push({
        text: message.trim()
      });
    }

    if (image) {
      currentParts.push({
        inline_data: {
          mime_type: mimeType,
          data: image
        }
      });
    }

    if (!message.trim() && image) {
      currentParts.push({
        text:
          "Bu şəkli diqqətlə təhlil et və gördüklərini Azərbaycan dilində izah et."
      });
    }

    const contents = [
      ...safeHistory,
      {
        role: "user",
        parts: currentParts
      }
    ];

    // Modellər keşdən alınır
    const availableModels = await getModels(apiKey);

    if (!availableModels.length) {
      return res.status(502).json({
        error:
          "Gemini API açarını və API icazələrini yoxla."
      });
    }

    // Mövcud modelləri prioritet sırası ilə düz
    const modelList = [
      ...PREFERRED_MODELS.filter(model =>
        availableModels.includes(model)
      ),
      ...availableModels.filter(model =>
        !PREFERRED_MODELS.includes(model)
      )
    ].slice(0, MAX_MODEL_ATTEMPTS);

    let lastStatus = 502;
    let lastError = "";

    // Avtomatik ehtiyat modelə keçid
    for (const model of modelList) {
      console.log("Yoxlanılan model:", model);

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
                parts: [
                  {
                    text: SYSTEM_PROMPT
                  }
                ]
              },
              contents,
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 4096
              }
            }),
            signal: AbortSignal.timeout(25000)
          }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          lastStatus = response.status;
          lastError = data.error?.message || "Naməlum API xətası";

          console.error(
            `Model ${model}:`,
            response.status,
            lastError
          );

          // Açar və icazə xətalarında başqa modeli yoxlama
          if ([401, 403].includes(response.status)) {
            return res.status(502).json({
              error:
                "Gemini API açarı və ya icazələri ilə bağlı xəta var."
            });
          }

          // Digər xətalarda növbəti modelə keç
          continue;
        }

        const answer = data.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("")
          .trim();

        if (answer) {
          console.log("Cavab verən model:", model);

          return res.json({
            success: true,
            answer,
            model
          });
        }

        lastError =
          data.promptFeedback?.blockReason ||
          data.candidates?.[0]?.finishReason ||
          "Model boş cavab qaytardı.";

      } catch (error) {
        lastError = error.message;

        console.error(
          `Model ${model} xətası:`,
          error.message
        );

        // Şəbəkə və vaxt aşımı xətalarında növbəti modelə keç
      }
    }

    console.error("Bütün modellər uğursuz oldu:", lastError);

    return res.status(502).json({
      error:
        "AI cavab verə bilmədi. Bir az sonra yenidən yoxla və ya API limitlərini yoxla.",
      status: lastStatus
    });

  } catch (error) {
    console.error("Server xətası:", error);

    return res.status(500).json({
      error: "Serverdə gözlənilməz xəta baş verdi."
    });
  }
});

// JSON ölçü və format xətaları
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: "Sorğu çox böyükdür. Daha kiçik şəkil göndər."
    });
  }

  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({
      error: "Göndərilən JSON məlumatı düzgün deyil."
    });
  }

  console.error("Middleware xətası:", err);

  return res.status(500).json({
    error: "Serverdə xəta baş verdi."
  });
});

// Əsas səhifə
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Serveri başlat
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hüm Chat AI ${PORT} portunda işləyir.`);
});
