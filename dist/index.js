// server/index.ts
import express2 from "express";

// server/routes.ts
import { createServer } from "http";

// shared/schema.ts
import { pgTable, text, serial, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
var users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull()
});
var insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true
});
var QuizCategoryEnum = z.enum([
  "General Knowledge",
  "Mathematics",
  "Science",
  "Reasoning",
  "Custom"
]);
var QuizCategorySchema = z.union([
  QuizCategoryEnum,
  z.string().min(1).max(50)
]);
var QuestionSchema = z.object({
  question: z.string(),
  answerDescription: z.string(),
  options: z.array(z.string()),
  correctAnswer: z.string(),
  questionImages: z.array(z.string()),
  answerImages: z.array(z.string())
});
var QuizAttemptSchema = z.object({
  date: z.coerce.date(),
  score: z.number(),
  totalQuestions: z.number(),
  timeSpent: z.number()
});
var quizzes = pgTable("quizzes", {
  id: serial("id").primaryKey(),
  uniqueId: text("unique_id").notNull().unique(),
  // For cross-device sync
  title: text("title").notNull(),
  description: text("description").notNull(),
  questions: jsonb("questions").notNull().$type(),
  timer: integer("timer").notNull(),
  category: text("category").notNull(),
  // Using QuizCategory
  history: jsonb("history").$type(),
  // Optional history
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastTaken: timestamp("last_taken"),
  password: text("password"),
  // Optional password
  isPublic: boolean("is_public").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id),
  version: integer("version").notNull().default(1)
});
var insertQuizSchema = createInsertSchema(quizzes).omit({ id: true }).extend({
  questions: z.array(QuestionSchema),
  category: QuizCategorySchema,
  history: z.array(QuizAttemptSchema).optional()
});
var syncQuizSchema = z.object({
  quizzes: z.array(insertQuizSchema)
});

// server/storage.ts
import { v4 as uuidv4 } from "uuid";
import { drizzle } from "drizzle-orm/neon-serverless";
import { neon } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
var MemStorage = class {
  users;
  quizCollection;
  userCurrentId;
  quizCurrentId;
  constructor() {
    this.users = /* @__PURE__ */ new Map();
    this.quizCollection = /* @__PURE__ */ new Map();
    this.userCurrentId = 1;
    this.quizCurrentId = 1;
  }
  // User methods
  async getUser(id) {
    return this.users.get(id);
  }
  async getUserByUsername(username) {
    return Array.from(this.users.values()).find(
      (user) => user.username === username
    );
  }
  async createUser(insertUser) {
    const id = this.userCurrentId++;
    const user = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }
  // Quiz methods
  async getQuiz(id) {
    return this.quizCollection.get(id);
  }
  async getQuizByUniqueId(uniqueId) {
    return Array.from(this.quizCollection.values()).find(
      (quiz) => quiz.uniqueId === uniqueId
    );
  }
  async getAllQuizzes() {
    return Array.from(this.quizCollection.values());
  }
  async getPublicQuizzes() {
    return Array.from(this.quizCollection.values()).filter(
      (quiz) => quiz.isPublic === true
    );
  }
  async createQuiz(quiz) {
    const id = this.quizCurrentId++;
    if (!quiz.uniqueId) {
      quiz.uniqueId = uuidv4();
    }
    const version = quiz.version || 1;
    const password = quiz.password === void 0 ? null : quiz.password;
    const newQuiz = {
      ...quiz,
      id,
      createdAt: quiz.createdAt || /* @__PURE__ */ new Date(),
      version,
      password
    };
    this.quizCollection.set(id, newQuiz);
    return newQuiz;
  }
  async updateQuiz(id, quizUpdate) {
    const existingQuiz = this.quizCollection.get(id);
    if (!existingQuiz) {
      return void 0;
    }
    const updatedQuiz = {
      ...existingQuiz,
      ...quizUpdate,
      version: existingQuiz.version ? existingQuiz.version + 1 : 1
    };
    this.quizCollection.set(id, updatedQuiz);
    return updatedQuiz;
  }
  async deleteQuiz(id) {
    return this.quizCollection.delete(id);
  }
  // Clean up private quizzes to save server storage
  async deletePrivateQuizzes() {
    let count = 0;
    const privateQuizzes = Array.from(this.quizCollection.values()).filter((quiz) => !quiz.isPublic);
    for (const quiz of privateQuizzes) {
      if (this.quizCollection.delete(quiz.id)) {
        count++;
      }
    }
    console.log(`Deleted ${count} private quizzes to save server storage`);
    return count;
  }
  // Helper function to create a content hash for quiz comparison
  createContentHash(quiz) {
    const titleNormalized = quiz.title.toLowerCase().trim();
    const questionsData = quiz.questions ? quiz.questions.map((q) => ({
      question: typeof q.question === "string" ? q.question.toLowerCase().trim() : "",
      options: Array.isArray(q.options) ? q.options.map((opt) => typeof opt === "string" ? opt.toLowerCase().trim() : "").sort().join("|") : "",
      correctAnswer: typeof q.correctAnswer === "string" ? q.correctAnswer.toLowerCase().trim() : ""
    })) : [];
    if (questionsData.length > 0) {
      questionsData.sort((a, b) => a.question.localeCompare(b.question));
    }
    return `${titleNormalized}:${questionsData.length}:${JSON.stringify(questionsData)}`;
  }
  // Method to identify and remove duplicate quizzes
  async removeDuplicateQuizzes() {
    console.log("Running server-side duplicate quiz detection...");
    const startTime = performance.now();
    const allQuizzes = Array.from(this.quizCollection.values());
    const uniqueIdMap = /* @__PURE__ */ new Map();
    const contentHashMap = /* @__PURE__ */ new Map();
    const uniqueQuizIds = /* @__PURE__ */ new Set();
    const duplicatesRemoved = [];
    for (const quiz of allQuizzes) {
      if (!quiz.uniqueId) {
        uniqueQuizIds.add(quiz.id);
        continue;
      }
      if (!uniqueIdMap.has(quiz.uniqueId)) {
        uniqueIdMap.set(quiz.uniqueId, quiz);
        uniqueQuizIds.add(quiz.id);
      } else {
        const existingQuiz = uniqueIdMap.get(quiz.uniqueId);
        const keepNew = quiz.version && existingQuiz.version && quiz.version > existingQuiz.version || quiz.createdAt && existingQuiz.createdAt && new Date(quiz.createdAt).getTime() > new Date(existingQuiz.createdAt).getTime();
        if (keepNew) {
          uniqueQuizIds.delete(existingQuiz.id);
          uniqueQuizIds.add(quiz.id);
          uniqueIdMap.set(quiz.uniqueId, quiz);
          duplicatesRemoved.push(existingQuiz);
          console.log(`Replacing duplicate quiz by uniqueId: "${existingQuiz.title}" with newer version`);
        } else {
          console.log(`Skipping older duplicate quiz by uniqueId: "${quiz.title}"`);
          duplicatesRemoved.push(quiz);
        }
      }
    }
    for (const quiz of allQuizzes) {
      if (!uniqueQuizIds.has(quiz.id)) continue;
      if (!quiz.uniqueId) {
        const contentHash = this.createContentHash(quiz);
        if (!contentHashMap.has(contentHash)) {
          contentHashMap.set(contentHash, quiz);
        } else {
          const existingQuiz = contentHashMap.get(contentHash);
          const keepNew = quiz.version && existingQuiz.version && quiz.version > existingQuiz.version || quiz.createdAt && existingQuiz.createdAt && new Date(quiz.createdAt).getTime() > new Date(existingQuiz.createdAt).getTime();
          if (keepNew) {
            uniqueQuizIds.delete(existingQuiz.id);
            uniqueQuizIds.add(quiz.id);
            contentHashMap.set(contentHash, quiz);
            duplicatesRemoved.push(existingQuiz);
            console.log(`Found duplicate quiz by content: "${existingQuiz.title}" - keeping newer version`);
          } else {
            uniqueQuizIds.delete(quiz.id);
            duplicatesRemoved.push(quiz);
            console.log(`Found duplicate quiz by content: "${quiz.title}" - keeping newer version`);
          }
        }
      }
    }
    const titleMap = /* @__PURE__ */ new Map();
    const finalUniqueQuizIds = new Set(uniqueQuizIds);
    for (const quiz of allQuizzes) {
      if (!uniqueQuizIds.has(quiz.id)) continue;
      const normalizedTitle = quiz.title.toLowerCase().trim();
      if (!titleMap.has(normalizedTitle)) {
        titleMap.set(normalizedTitle, [quiz]);
      } else {
        titleMap.get(normalizedTitle).push(quiz);
      }
    }
    for (const [title, quizzesWithSameTitle] of titleMap.entries()) {
      if (quizzesWithSameTitle.length > 1) {
        console.log(`Found ${quizzesWithSameTitle.length} quizzes with title "${title}" - checking for duplicates`);
        for (let i = 0; i < quizzesWithSameTitle.length; i++) {
          const quiz1 = quizzesWithSameTitle[i];
          if (!finalUniqueQuizIds.has(quiz1.id)) continue;
          for (let j = i + 1; j < quizzesWithSameTitle.length; j++) {
            const quiz2 = quizzesWithSameTitle[j];
            if (!finalUniqueQuizIds.has(quiz2.id)) continue;
            if (quiz1.uniqueId && quiz2.uniqueId && quiz1.uniqueId !== quiz2.uniqueId) {
              continue;
            }
            if (quiz1.questions && quiz2.questions) {
              if (Math.abs(quiz1.questions.length - quiz2.questions.length) <= 1) {
                let matchCount = 0;
                for (const q1 of quiz1.questions) {
                  for (const q2 of quiz2.questions) {
                    if (q1.question.toLowerCase().trim() === q2.question.toLowerCase().trim() || q1.correctAnswer.toLowerCase().trim() === q2.correctAnswer.toLowerCase().trim()) {
                      matchCount++;
                      break;
                    }
                  }
                }
                const threshold = Math.min(quiz1.questions.length, quiz2.questions.length) * 0.8;
                if (matchCount >= threshold) {
                  console.log(`Found duplicate quizzes with title "${title}" by question similarity`);
                  const keepQuiz1 = quiz1.version && quiz2.version && quiz1.version > quiz2.version || quiz1.createdAt && quiz2.createdAt && new Date(quiz1.createdAt).getTime() > new Date(quiz2.createdAt).getTime();
                  if (keepQuiz1) {
                    finalUniqueQuizIds.delete(quiz2.id);
                    duplicatesRemoved.push(quiz2);
                    console.log(`Keeping quiz "${quiz1.title}" (ID: ${quiz1.id}) as it's newer`);
                  } else {
                    finalUniqueQuizIds.delete(quiz1.id);
                    duplicatesRemoved.push(quiz1);
                    console.log(`Keeping quiz "${quiz2.title}" (ID: ${quiz2.id}) as it's newer`);
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }
    let deleteCount = 0;
    for (const quiz of duplicatesRemoved) {
      console.log(`Removing duplicate quiz: "${quiz.title}" (ID: ${quiz.id}, uniqueId: ${quiz.uniqueId || "none"})`);
      if (this.quizCollection.delete(quiz.id)) {
        deleteCount++;
      }
    }
    const endTime = performance.now();
    console.log(`Removed ${deleteCount} duplicate quizzes in ${(endTime - startTime).toFixed(2)}ms`);
    return deleteCount;
  }
  async syncQuizzes(quizzesToSync) {
    const publicQuizzesToSync = quizzesToSync.filter((quiz) => quiz.isPublic === true);
    console.log(`Processing ${publicQuizzesToSync.length} public quizzes out of ${quizzesToSync.length} total quizzes`);
    for (const quizToSync of publicQuizzesToSync) {
      if (!quizToSync.uniqueId) {
        console.log("Skipping quiz without uniqueId");
        continue;
      }
      const existingQuiz = await this.getQuizByUniqueId(quizToSync.uniqueId);
      if (existingQuiz) {
        console.log(`Updating existing public quiz: ${quizToSync.title} (uniqueId: ${quizToSync.uniqueId})`);
        await this.updateQuiz(existingQuiz.id, quizToSync);
      } else {
        console.log(`Creating new public quiz: ${quizToSync.title} (uniqueId: ${quizToSync.uniqueId})`);
        await this.createQuiz(quizToSync);
      }
    }
    for (const quizToSync of quizzesToSync) {
      if (!quizToSync.isPublic && quizToSync.uniqueId) {
        const existingQuiz = await this.getQuizByUniqueId(quizToSync.uniqueId);
        if (existingQuiz) {
          console.log(`Quiz ${quizToSync.title} is now private - removing from server`);
          await this.deleteQuiz(existingQuiz.id);
        }
      }
    }
    await this.deletePrivateQuizzes();
    return await this.getPublicQuizzes();
  }
};
var DbStorage = class {
  db;
  constructor() {
    try {
      const sql = neon(process.env.DATABASE_URL);
      this.db = drizzle({
        driver: sql
      });
    } catch (error) {
      console.error("Database connection error:", error);
      throw new Error("Database connection failed. Check your DATABASE_URL environment variable.");
    }
  }
  // User methods
  async getUser(id) {
    const result = await this.db.select().from(users).where(eq(users.id, id));
    return result[0];
  }
  async getUserByUsername(username) {
    const result = await this.db.select().from(users).where(eq(users.username, username));
    return result[0];
  }
  async createUser(insertUser) {
    const result = await this.db.insert(users).values(insertUser).returning();
    return result[0];
  }
  // Quiz methods
  async getQuiz(id) {
    const result = await this.db.select().from(quizzes).where(eq(quizzes.id, id));
    return result[0];
  }
  async getQuizByUniqueId(uniqueId) {
    const result = await this.db.select().from(quizzes).where(eq(quizzes.uniqueId, uniqueId));
    return result[0];
  }
  async getAllQuizzes() {
    return await this.db.select().from(quizzes);
  }
  async getPublicQuizzes() {
    return await this.db.select().from(quizzes).where(eq(quizzes.isPublic, true));
  }
  async createQuiz(quiz) {
    if (!quiz.uniqueId) {
      quiz.uniqueId = uuidv4();
    }
    const result = await this.db.insert(quizzes).values(quiz).returning();
    return result[0];
  }
  async updateQuiz(id, quizUpdate) {
    let currentQuiz = await this.getQuiz(id);
    if (!currentQuiz) {
      return void 0;
    }
    const newVersion = currentQuiz.version ? currentQuiz.version + 1 : 1;
    const result = await this.db.update(quizzes).set({ ...quizUpdate, version: newVersion }).where(eq(quizzes.id, id)).returning();
    return result[0];
  }
  async deleteQuiz(id) {
    const result = await this.db.delete(quizzes).where(eq(quizzes.id, id)).returning();
    return result.length > 0;
  }
  // New method to clean up private quizzes to save server storage
  async deletePrivateQuizzes() {
    const result = await this.db.delete(quizzes).where(eq(quizzes.isPublic, false)).returning();
    console.log(`Deleted ${result.length} private quizzes to save server storage`);
    return result.length;
  }
  // Function to create a content hash for a quiz to identify duplicate content
  createContentHash(quiz) {
    const titleNormalized = quiz.title.toLowerCase().trim();
    const questionsData = quiz.questions ? quiz.questions.map((q) => ({
      question: typeof q.question === "string" ? q.question.toLowerCase().trim() : "",
      options: Array.isArray(q.options) ? q.options.map((opt) => typeof opt === "string" ? opt.toLowerCase().trim() : "").sort().join("|") : "",
      correctAnswer: typeof q.correctAnswer === "string" ? q.correctAnswer.toLowerCase().trim() : ""
    })) : [];
    if (questionsData.length > 0) {
      questionsData.sort((a, b) => a.question.localeCompare(b.question));
    }
    return `${titleNormalized}:${questionsData.length}:${JSON.stringify(questionsData)}`;
  }
  // Method to identify and remove duplicate quizzes in the database
  async removeDuplicateQuizzes() {
    console.log("Running server-side duplicate quiz detection in database...");
    const startTime = performance.now();
    const allQuizzes = await this.getAllQuizzes();
    const uniqueIdMap = /* @__PURE__ */ new Map();
    const contentHashMap = /* @__PURE__ */ new Map();
    const quizzesToKeep = /* @__PURE__ */ new Set();
    const duplicatesToRemove = [];
    for (const quiz of allQuizzes) {
      if (!quiz.uniqueId) {
        quizzesToKeep.add(quiz.id);
        continue;
      }
      if (!uniqueIdMap.has(quiz.uniqueId)) {
        uniqueIdMap.set(quiz.uniqueId, quiz);
        quizzesToKeep.add(quiz.id);
      } else {
        const existingQuiz = uniqueIdMap.get(quiz.uniqueId);
        const keepNew = quiz.version && existingQuiz.version && quiz.version > existingQuiz.version || quiz.createdAt && existingQuiz.createdAt && new Date(quiz.createdAt).getTime() > new Date(existingQuiz.createdAt).getTime();
        if (keepNew) {
          quizzesToKeep.delete(existingQuiz.id);
          quizzesToKeep.add(quiz.id);
          uniqueIdMap.set(quiz.uniqueId, quiz);
          duplicatesToRemove.push(existingQuiz);
          console.log(`Replacing duplicate quiz by uniqueId: "${existingQuiz.title}" with newer version`);
        } else {
          console.log(`Skipping older duplicate quiz by uniqueId: "${quiz.title}"`);
          duplicatesToRemove.push(quiz);
        }
      }
    }
    for (const quiz of allQuizzes) {
      if (!quizzesToKeep.has(quiz.id)) continue;
      if (!quiz.uniqueId) {
        const contentHash = this.createContentHash(quiz);
        if (!contentHashMap.has(contentHash)) {
          contentHashMap.set(contentHash, quiz);
        } else {
          const existingQuiz = contentHashMap.get(contentHash);
          const keepNew = quiz.version && existingQuiz.version && quiz.version > existingQuiz.version || quiz.createdAt && existingQuiz.createdAt && new Date(quiz.createdAt).getTime() > new Date(existingQuiz.createdAt).getTime();
          if (keepNew) {
            quizzesToKeep.delete(existingQuiz.id);
            quizzesToKeep.add(quiz.id);
            contentHashMap.set(contentHash, quiz);
            duplicatesToRemove.push(existingQuiz);
            console.log(`Found duplicate quiz by content: "${existingQuiz.title}" - keeping newer version`);
          } else {
            quizzesToKeep.delete(quiz.id);
            duplicatesToRemove.push(quiz);
            console.log(`Found duplicate quiz by content: "${quiz.title}" - keeping newer version`);
          }
        }
      }
    }
    const titleMap = /* @__PURE__ */ new Map();
    const quizzesWithUniqueTitle = [];
    for (const quiz of allQuizzes) {
      if (!quizzesToKeep.has(quiz.id)) continue;
      const normalizedTitle = quiz.title.toLowerCase().trim();
      if (!titleMap.has(normalizedTitle)) {
        titleMap.set(normalizedTitle, [quiz]);
        quizzesWithUniqueTitle.push(quiz);
      } else {
        titleMap.get(normalizedTitle).push(quiz);
      }
    }
    for (const [title, quizzesWithSameTitle] of titleMap.entries()) {
      if (quizzesWithSameTitle.length > 1) {
        console.log(`Found ${quizzesWithSameTitle.length} quizzes with title "${title}" - checking for duplicates`);
        for (let i = 0; i < quizzesWithSameTitle.length; i++) {
          const quiz1 = quizzesWithSameTitle[i];
          if (!quizzesToKeep.has(quiz1.id)) continue;
          for (let j = i + 1; j < quizzesWithSameTitle.length; j++) {
            const quiz2 = quizzesWithSameTitle[j];
            if (!quizzesToKeep.has(quiz2.id)) continue;
            if (quiz1.uniqueId && quiz2.uniqueId && quiz1.uniqueId !== quiz2.uniqueId) {
              continue;
            }
            if (quiz1.questions && quiz2.questions) {
              if (Math.abs(quiz1.questions.length - quiz2.questions.length) <= 1) {
                let matchCount = 0;
                for (const q1 of quiz1.questions) {
                  for (const q2 of quiz2.questions) {
                    if (q1.question.toLowerCase().trim() === q2.question.toLowerCase().trim() || q1.correctAnswer.toLowerCase().trim() === q2.correctAnswer.toLowerCase().trim()) {
                      matchCount++;
                      break;
                    }
                  }
                }
                const threshold = Math.min(quiz1.questions.length, quiz2.questions.length) * 0.8;
                if (matchCount >= threshold) {
                  console.log(`Found duplicate quizzes with title "${title}" by question similarity`);
                  const keepQuiz1 = quiz1.version && quiz2.version && quiz1.version > quiz2.version || quiz1.createdAt && quiz2.createdAt && new Date(quiz1.createdAt).getTime() > new Date(quiz2.createdAt).getTime();
                  if (keepQuiz1) {
                    quizzesToKeep.delete(quiz2.id);
                    duplicatesToRemove.push(quiz2);
                    console.log(`Keeping quiz "${quiz1.title}" (ID: ${quiz1.id}) as it's newer`);
                  } else {
                    quizzesToKeep.delete(quiz1.id);
                    duplicatesToRemove.push(quiz1);
                    console.log(`Keeping quiz "${quiz2.title}" (ID: ${quiz2.id}) as it's newer`);
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }
    let deleteCount = 0;
    for (const quiz of duplicatesToRemove) {
      console.log(`Removing duplicate quiz from DB: "${quiz.title}" (ID: ${quiz.id}, uniqueId: ${quiz.uniqueId || "none"})`);
      if (await this.deleteQuiz(quiz.id)) {
        deleteCount++;
      }
    }
    const endTime = performance.now();
    console.log(`Removed ${deleteCount} duplicate quizzes in ${(endTime - startTime).toFixed(2)}ms`);
    return deleteCount;
  }
  async syncQuizzes(quizzesToSync) {
    const publicQuizzesToSync = quizzesToSync.filter((quiz) => quiz.isPublic === true);
    console.log(`Processing ${publicQuizzesToSync.length} public quizzes out of ${quizzesToSync.length} total quizzes`);
    for (const quizToSync of publicQuizzesToSync) {
      if (!quizToSync.uniqueId) {
        console.log("Skipping quiz without uniqueId");
        continue;
      }
      const existingQuiz = await this.getQuizByUniqueId(quizToSync.uniqueId);
      if (existingQuiz) {
        console.log(`Updating existing public quiz: ${quizToSync.title} (uniqueId: ${quizToSync.uniqueId})`);
        await this.updateQuiz(existingQuiz.id, quizToSync);
      } else {
        console.log(`Creating new public quiz: ${quizToSync.title} (uniqueId: ${quizToSync.uniqueId})`);
        await this.createQuiz(quizToSync);
      }
    }
    for (const quizToSync of quizzesToSync) {
      if (!quizToSync.isPublic && quizToSync.uniqueId) {
        const existingQuiz = await this.getQuizByUniqueId(quizToSync.uniqueId);
        if (existingQuiz) {
          console.log(`Quiz ${quizToSync.title} is now private - removing from server`);
          await this.deleteQuiz(existingQuiz.id);
        }
      }
    }
    await this.deletePrivateQuizzes();
    return await this.getPublicQuizzes();
  }
};
var storage = process.env.DATABASE_URL ? new DbStorage() : new MemStorage();

// server/routes.ts
import { z as z2 } from "zod";
async function registerRoutes(app2) {
  app2.get("/api/quizzes", async (req, res) => {
    try {
      const quizzes2 = await storage.getPublicQuizzes();
      res.json(quizzes2);
    } catch (error) {
      console.error("Error fetching quizzes:", error);
      res.status(500).json({ message: "Failed to fetch quizzes" });
    }
  });
  app2.get("/api/quizzes/unique/:uniqueId", async (req, res) => {
    try {
      const uniqueId = req.params.uniqueId;
      const quiz = await storage.getQuizByUniqueId(uniqueId);
      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found" });
      }
      res.json(quiz);
    } catch (error) {
      console.error("Error fetching quiz by unique ID:", error);
      res.status(500).json({ message: "Failed to fetch quiz" });
    }
  });
  app2.get("/api/quizzes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid quiz ID" });
      }
      const quiz = await storage.getQuiz(id);
      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found" });
      }
      res.json(quiz);
    } catch (error) {
      console.error("Error fetching quiz:", error);
      res.status(500).json({ message: "Failed to fetch quiz" });
    }
  });
  app2.post("/api/quizzes", async (req, res) => {
    try {
      const quizData = insertQuizSchema.parse(req.body);
      const quiz = await storage.createQuiz(quizData);
      res.status(201).json(quiz);
    } catch (error) {
      console.error("Error creating quiz:", error);
      if (error instanceof z2.ZodError) {
        return res.status(400).json({
          message: "Invalid quiz data",
          errors: error.errors
        });
      }
      res.status(500).json({ message: "Failed to create quiz" });
    }
  });
  app2.put("/api/quizzes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid quiz ID" });
      }
      const quizData = insertQuizSchema.partial().parse(req.body);
      const updatedQuiz = await storage.updateQuiz(id, quizData);
      if (!updatedQuiz) {
        return res.status(404).json({ message: "Quiz not found" });
      }
      res.json(updatedQuiz);
    } catch (error) {
      console.error("Error updating quiz:", error);
      if (error instanceof z2.ZodError) {
        return res.status(400).json({
          message: "Invalid quiz data",
          errors: error.errors
        });
      }
      res.status(500).json({ message: "Failed to update quiz" });
    }
  });
  app2.delete("/api/quizzes/unique/:uniqueId", async (req, res) => {
    try {
      const uniqueId = req.params.uniqueId;
      console.log(`Attempting to delete quiz with uniqueId: ${uniqueId}`);
      const quiz = await storage.getQuizByUniqueId(uniqueId);
      if (!quiz) {
        console.log(`Quiz with uniqueId ${uniqueId} not found`);
        return res.status(404).json({ message: "Quiz not found" });
      }
      console.log(`Found quiz to delete: ID ${quiz.id}, title: "${quiz.title}"`);
      const success = await storage.deleteQuiz(quiz.id);
      if (!success) {
        console.log(`Failed to delete quiz with ID ${quiz.id}`);
        return res.status(500).json({ message: "Failed to delete quiz" });
      }
      console.log(`Successfully deleted quiz with ID ${quiz.id}, title: "${quiz.title}"`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting quiz by uniqueId:", error);
      res.status(500).json({ message: "Failed to delete quiz" });
    }
  });
  app2.delete("/api/quizzes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid quiz ID" });
      }
      console.log(`Attempting to delete quiz with ID: ${id}`);
      const success = await storage.deleteQuiz(id);
      if (!success) {
        console.log(`Quiz with ID ${id} not found`);
        return res.status(404).json({ message: "Quiz not found" });
      }
      console.log(`Successfully deleted quiz with ID ${id}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting quiz:", error);
      res.status(500).json({ message: "Failed to delete quiz" });
    }
  });
  app2.post("/api/quizzes/cleanup", async (_req, res) => {
    try {
      console.log("Manual cleanup of duplicate quizzes requested");
      const removedCount = await storage.removeDuplicateQuizzes();
      if (removedCount > 0) {
        console.log(`Successfully removed ${removedCount} duplicate quizzes`);
        res.json({
          success: true,
          message: `Successfully removed ${removedCount} duplicate quizzes`,
          removedCount
        });
      } else {
        console.log("No duplicate quizzes found to remove");
        res.json({
          success: true,
          message: "No duplicate quizzes found to remove",
          removedCount: 0
        });
      }
    } catch (error) {
      console.error("Error cleaning up duplicate quizzes:", error);
      res.status(500).json({
        success: false,
        message: "Failed to clean up duplicate quizzes"
      });
    }
  });
  app2.post("/api/quizzes/sync", async (req, res) => {
    try {
      const processedData = {
        quizzes: req.body.quizzes.map((quiz) => {
          return {
            ...quiz,
            // Convert string dates to Date objects
            createdAt: quiz.createdAt ? new Date(quiz.createdAt) : /* @__PURE__ */ new Date(),
            lastTaken: quiz.lastTaken ? new Date(quiz.lastTaken) : void 0,
            // Convert string dates in quiz history if it exists
            history: quiz.history?.map((attempt) => ({
              ...attempt,
              date: attempt.date ? new Date(attempt.date) : /* @__PURE__ */ new Date()
            }))
          };
        })
      };
      const syncData = syncQuizSchema.parse(processedData);
      const syncedQuizzes = await storage.syncQuizzes(syncData.quizzes);
      const removedCount = await storage.removeDuplicateQuizzes();
      if (removedCount > 0) {
        console.log(`Removed ${removedCount} duplicate quizzes during sync operation`);
      }
      const allPublicQuizzes = await storage.getPublicQuizzes();
      res.json(allPublicQuizzes);
    } catch (error) {
      console.error("Error syncing quizzes:", error);
      if (error instanceof z2.ZodError) {
        return res.status(400).json({
          message: "Invalid sync data",
          errors: error.errors
        });
      }
      res.status(500).json({ message: "Failed to sync quizzes" });
    }
  });
  const httpServer = createServer(app2);
  return httpServer;
}

// server/vite.ts
import express from "express";
import fs from "fs";
import path2, { dirname as dirname2 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
import { createServer as createViteServer, createLogger } from "vite";

// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import themePlugin from "@replit/vite-plugin-shadcn-theme-json";
import path, { dirname } from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { fileURLToPath } from "url";
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var vite_config_default = defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    themePlugin(),
    ...process.env.NODE_ENV !== "production" && process.env.REPL_ID !== void 0 ? [
      await import("@replit/vite-plugin-cartographer").then(
        (m) => m.cartographer()
      )
    ] : []
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared")
    }
  },
  root: path.resolve(__dirname, "client"),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true
  }
});

// server/vite.ts
import { nanoid } from "nanoid";
var __filename2 = fileURLToPath2(import.meta.url);
var __dirname2 = dirname2(__filename2);
var viteLogger = createLogger();
function log(message, source = "express") {
  const formattedTime = (/* @__PURE__ */ new Date()).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}
async function setupVite(app2, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      }
    },
    server: serverOptions,
    appType: "custom"
  });
  app2.use(vite.middlewares);
  app2.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        __dirname2,
        "..",
        "client",
        "index.html"
      );
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app2) {
  const distPath = path2.resolve(__dirname2, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app2.use(express.static(distPath));
  app2.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/index.ts
import http from "http";
var app = express2();
app.use(express2.json());
app.use(express2.urlencoded({ extended: false }));
app.use((req, res, next) => {
  const start = Date.now();
  const path3 = req.path;
  let capturedJsonResponse = void 0;
  const originalResJson = res.json;
  res.json = function(bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path3.startsWith("/api")) {
      let logLine = `${req.method} ${path3} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      log(logLine);
    }
  });
  next();
});
(async () => {
  const server = await registerRoutes(app);
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    throw err;
  });
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const port = 5e3;
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true
  }, () => {
    log(`serving on port ${port}`);
    function pingServer() {
      const options = {
        host: "localhost",
        port,
        path: "/api/quizzes",
        method: "GET",
        timeout: 1e4
      };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          log(`[Keep-alive] Server pinged successfully - Status: ${res.statusCode}`);
        });
      });
      req.on("error", (e) => {
        log(`[Keep-alive] Server ping failed: ${e.message}`);
      });
      req.on("timeout", () => {
        req.destroy();
        log(`[Keep-alive] Server ping timed out`);
      });
      req.end();
    }
    const pingInterval = 4 * 60 * 1e3;
    setInterval(pingServer, pingInterval);
    log(`[Keep-alive] Self-ping mechanism started. Server will ping itself every ${pingInterval / 6e4} minutes.`);
  });
})();
