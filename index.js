require("dotenv").config(); // must run before anything reads process.env

const express = require("express");
const postgres = require("postgres");
const cors = require("cors");

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

// prepare: false is required for Supabase's pooler on port 6543 (transaction mode)
// and harmless otherwise
const sql = postgres(process.env.DATABASE_URL, { prepare: false });

// ---- Elo settings ----
const K_FACTOR = 32; // how much one match can move a rating
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns the new ratings after `winner` beats `loser`
function eloUpdate(winnerRating, loserRating, k = K_FACTOR) {
  // Probability the winner was expected to win
  const expectedWin = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const delta = k * (1 - expectedWin); // upset = big delta, expected win = small delta
  return {
    winner: winnerRating + delta,
    loser: loserRating - delta,
    delta,
  };
}

// Request logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Health check
app.get("/health", async (req, res) => {
  try {
    await sql`SELECT 1`;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(503).json({ ok: false, error: "database unavailable" });
  }
});

app.get("/top", async (req, res) => {
  try {
    const top = await sql`select * from persons
              order by score desc
              limit 1;`;
    res.json(top);
  } catch (err){
    console.error(err);
    res.status(503).json({ "error": err });
  }
});

// List professors (the rows inserted by the Python script), best rated first
app.get("/personas", async (req, res) => {
  try {
    const personas = await sql`
      SELECT * FROM persons
      ORDER BY score DESC, apellidos, name
    `;
    res.json(personas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load personas" });
  }
});

// Two random professors to face off
app.get("/match", async (req, res) => {
  try {
    const pair = await sql`
      SELECT id, name, apellidos, department, image_url, score
      FROM persons
      ORDER BY random()
      LIMIT 2
    `;
    if (pair.length < 2) {
      return res.status(404).json({ error: "need at least 2 personas" });
    }
    res.json(pair);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load match" });
  }
});

// Record a result: body { "winnerId": "<uuid>", "loserId": "<uuid>" }
app.post("/vote", async (req, res) => {
  const { winnerId, loserId } = req.body || {};

  if (!UUID_RE.test(winnerId || "") || !UUID_RE.test(loserId || "")) {
    return res.status(400).json({ error: "winnerId and loserId must be UUIDs" });
  }
  if (winnerId === loserId) {
    return res.status(400).json({ error: "winner and loser must be different" });
  }

  try {
    const result = await sql.begin(async (tx) => {
      // Lock both rows so two simultaneous votes can't overwrite each other.
      // ORDER BY id keeps lock order consistent and avoids deadlocks.
      const rows = await tx`
        SELECT id, score FROM persons
        WHERE id IN (${winnerId}, ${loserId})
        ORDER BY id
        FOR UPDATE
      `;
      if (rows.length !== 2) return null;

      const winner = rows.find((r) => r.id === winnerId);
      const loser = rows.find((r) => r.id === loserId);
      const next = eloUpdate(winner.score, loser.score);

      await tx`UPDATE persons SET score = ${next.winner} WHERE id = ${winnerId}`;
      await tx`UPDATE persons SET score = ${next.loser} WHERE id = ${loserId}`;

      return {
        winner: { id: winnerId, before: winner.score, after: next.winner },
        loser: { id: loserId, before: loser.score, after: next.loser },
        delta: next.delta,
      };
    });

    if (!result) {
      return res.status(404).json({ error: "persona not found" });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to record vote" });
  }
});

// Create a user
app.post("/create-user", async (req, res) => {
  // Only take the fields you expect — never insert req.body directly
  const { name, apellidos, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: "name and email are required" });
  }

  try {
    const [user] = await sql`
      INSERT INTO users ${sql({ name, apellidos, email })}
      RETURNING *
    `;
    res.status(201).json(user);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      // unique constraint violation
      return res.status(409).json({ error: "user already exists" });
    }
    res.status(500).json({ error: "Failed to create a user" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ITC Social API listening on port ${PORT}`);
});