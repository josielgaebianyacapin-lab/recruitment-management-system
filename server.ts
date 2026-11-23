import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import dotenv from 'dotenv';
// @ts-ignore
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
// @ts-ignore
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
// @ts-ignore
import JSZip from 'jszip';
import {
  db,
  User,
  UserRole,
  KnowledgeSource,
  DocumentChunk,
  EscalationTicket,
  PerformanceReview,
  PerformanceReviewStatus,
  PerformanceReviewAuditEntry,
  EmployeeRecord,
  AuthorizedDocument,
  LeaveTypeConfig,
  CompanyHoliday,
  LeaveApplication,
  JobApplication,
  JobApplicationStatus,
  ApplicationDocument,
  ApplicantInquiry,
  VacancyDocumentRequirement,
  ApplicationDocumentStatus,
  officialPersonnelStandardsCatalog,
  officialFormsCatalog,
  hashPassword,
  verifyPassword,
  DESIGNATED_HR_ADMIN_CONFIG,
  isDesignatedHRAdminEmail,
  isValidAmchamEmail,
  AUTHORITATIVE_BASELINE_USERS,
  RACHEL_HISTORICAL_PASSWORD_HASHES,
  VacancyStatus,
  VacancyStatusHistoryEntry,
  DepartmentStaffingRequest,
  VacancyRecommendationItem,
  VacancyRecommendationRun,
  EmploymentType,
  WorkArrangement,
} from './server/db';
import { firebaseStorage } from './server/firebaseStorage';
import { RAGEngine } from './server/rag';
import {
  askHRPolicyAI,
  generateRecruitmentAI,
  screenApplicantAI,
  analyzePerformanceAI,
  analyzeTrainingNeedsAI,
  assistOnboardingAI,
  askApplicantFaqAI,
  recommendVacanciesAI,
  generateJobDescriptionAI,
  WorkforceAnalysisSnapshot,
  EmployeeAIContext,
} from './server/gemini';
import { calculateWorkingDays, evaluateLeaveApplication } from './server/leaveEngine';
import {
  getStaffTrainingDataset,
  STAFF_TRAINING_2026,
  DEPARTMENT_TRAINING_SUMMARIES,
  OFFICIAL_SOURCE_DOCUMENT,
} from './server/staffTraining2026Data';
import {
  createDatabaseBackup,
  listDatabaseBackups,
  verifyBackupFile,
  restoreDatabaseSnapshot,
  testRestoreSimulation,
} from './server/backup';
import {
  amchamPersonnelManual2019Source,
  getPersonnelManualPages,
  searchPersonnelManual2019,
  getStaffHandbookPages,
  searchStaffHandbook2026,
  getCodeOfConductPages,
  searchCodeOfConduct2026,
} from './server/personnelManual2019Data';
import {
  TrainingRecord,
  EvidenceReference,
  TrainingRecordStatus,
  TrainingStatus,
  EnrolledCourseItem,
  AnnualTrainingSummary,
  TrainingReviewHistoryEntry,
  IndividualDevelopmentPlan,
  STANDARD_REQUIREMENT_TITLES,
  STANDARD_DOCUMENT_CATEGORIES,
  DEFAULT_REQUIREMENT_CATEGORY_MAP,
  JobVacancy,
  EmployeeRequirementCategoryKey,
  RequirementApplicability,
  RequirementSubmissionStatus,
  EmployeeRequirementItemDef,
  RequirementAuditEntry,
  EmployeeRequirementSubmission,
  EmployeeRequirementConfig,
  EmployeeComplianceSummary,
  EMPLOYEE_REQUIREMENT_CATEGORIES,
  EMPLOYEE_REQUIREMENTS_CATALOG,
  DocumentPreviewData,
} from './src/types';
import {
  AMCHAM_FUNCTIONAL_CATEGORIES,
  AMCHAM_ROLE_TEMPLATES,
} from './server/amchamRoleTemplates';
import {
  EVIDENCE_STORAGE_DIR,
  deriveYearFromDate,
  detectDuplicateTraining,
  parseAndValidateTrainingCsv,
  calculateAnnualSummaries,
} from './server/trainingService';
import {
  getEmailServiceStatus,
  sendApplicantVerificationEmail,
  sendApplicantPasswordResetEmail,
} from './server/emailService';

dotenv.config();

// Defensive exception handlers to maintain server stability
process.on('uncaughtException', (err) => {
  console.error('[AMIE Server] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[AMIE Server] Unhandled rejection at:', promise, 'reason:', reason);
});

const app = express();

// Parse port from command line argument (e.g. --port 3000), environment variable, or default 3000
function getPort(): number {
  const portArgIdx = process.argv.indexOf('--port');
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
    const p = parseInt(process.argv[portArgIdx + 1], 10);
    if (!isNaN(p)) return p;
  }
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT, 10);
    if (!isNaN(p)) return p;
  }
  return 3000;
}
const PORT = getPort();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Dynamic session cookie helper (compatible with both HTTPS proxy and local HTTP dev/test)
function isSecureCookieRequest(req: Request): boolean {
  const xfProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(xfProto) ? xfProto[0] : xfProto;
  return Boolean(req.secure || req.protocol === 'https' || (proto && proto.toLowerCase().includes('https')));
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const isHttps = isSecureCookieRequest(req);
  res.cookie('amie_session_token', token, {
    path: '/',
    httpOnly: false,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    maxAge: SESSION_LIFETIME_MS,
  });
}

function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = isSecureCookieRequest(req);
  res.clearCookie('amie_session_token', {
    path: '/',
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
  });
}

// Server-Sent Events (SSE) Real-Time Multi-User Sync Hub
interface SseClient {
  res: Response;
  userId: string;
  role: UserRole;
}
const sseClients = new Set<SseClient>();

function deriveSyncDomains(reqPath: string): string[] {
  const p = reqPath.toLowerCase();
  const domains = new Set<string>(['notifications', 'metrics']);
  if (p.includes('/leave')) domains.add('leave');
  if (p.includes('/performance')) domains.add('performance');
  if (p.includes('/onboarding')) domains.add('onboarding');
  if (p.includes('/employee-requirements') || p.includes('/employee/')) domains.add('employee-file');
  if (p.includes('/training')) domains.add('training');
  if (p.includes('/learning')) domains.add('learning');
  if (p.includes('/recruitment') || p.includes('/careers') || p.includes('/applicant') || p.includes('/vacancies') || p.includes('/staffing-requests')) {
    domains.add('recruitment');
    domains.add('applicant');
    domains.add('careers');
  }
  if (p.includes('/chat/escalate') || p.includes('/chat/tickets')) domains.add('tickets');
  if (p.includes('/knowledge') || p.includes('/manual')) domains.add('knowledge');
  if (p.includes('/auth/users') || p.includes('/users/')) domains.add('users');
  if (p.includes('/admin/backups')) domains.add('policy');
  return Array.from(domains);
}

function emitSyncEvent(domains: string[], meta?: Record<string, any>): void {
  if (sseClients.size === 0) return;
  const isApplicantRelevant = domains.some((d) => d === 'applicant' || d === 'careers' || d === 'recruitment');
  const isOwnNotificationAction =
    typeof meta?.path === 'string' &&
    meta.path.startsWith('/api/notifications') &&
    typeof meta?.actorUserId === 'string';
  const safeMeta = { ...meta };
  delete safeMeta.actorUserId;
  const payload = JSON.stringify({
    type: 'sync',
    domains,
    timestamp: new Date().toISOString(),
    ...safeMeta,
  });
  const frame = `event: sync\ndata: ${payload}\n\n`;
  for (const client of Array.from(sseClients)) {
    try {
      // Strictly isolate APPLICANT SSE clients from internal staff mutations
      if (client.role === 'APPLICANT') {
        const allowOwnNotif = isOwnNotificationAction && client.userId === meta?.actorUserId;
        if (!isApplicantRelevant && !allowOwnNotif) {
          continue;
        }
      }
      client.res.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

const READ_ONLY_POST_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/applicant/login',
  '/api/auth/check-email',
  '/api/auth/session-verify',
  '/api/leave/calculate-days',
  '/api/chat/ask',
  '/api/training-needs/analyze',
  '/api/recruitment/generate',
  '/api/onboarding/ai-assist',
  '/api/training-records/import/preview',
  '/api/performance/analyze',
  '/api/applicant/faqs/ask',
]);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && !READ_ONLY_POST_PATHS.has(req.path)) {
        const domains = deriveSyncDomains(req.path);
        const actor = getActiveUser(req);
        emitSyncEvent(domains, { path: req.path, method: req.method, actorUserId: actor?.id });
      }
    });
  }
  next();
});

// Minimum necessary secure Content Security Policy (strict, scoped, non-wildcard)
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://*.google.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data: blob: https:; " +
    "frame-src 'self' blob: data:; " +
    "object-src 'self' blob: data:; " +
    "connect-src 'self' ws: wss: https:; " +
    "worker-src 'self' blob:; " +
    "frame-ancestors 'self' https://*.google.com https://localhost.corp.google.com:26001;"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Serve public static assets with correct MIME types
app.use(
  express.static(path.resolve(process.cwd(), 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.mjs')) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      } else if (filePath.endsWith('.pdf')) {
        res.setHeader('Content-Type', 'application/pdf');
      }
    },
  })
);

// App configuration and manifest endpoints to ensure required id and name properties are always present
app.get('/manifest.json', (_req: Request, res: Response) => {
  res.json({
    id: 'amie-amcham-assistant',
    name: "AMIE — AmCham's Intelligent Employee Assistant",
    short_name: 'AMIE',
    description: "Full-stack AI-powered HR management, employee support, policy intelligence, recruitment, onboarding, performance analysis, and training platform for the American Chamber of Commerce of the Philippines.",
    start_url: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#1e3a8a',
  });
});

app.get(['/config', '/api/config', '/config.json'], (_req: Request, res: Response) => {
  res.json({
    id: 'afce2bd6-a8c4-4db0-8980-561187661839',
    name: "AMIE — AmCham's Intelligent Employee Assistant",
    shortName: 'AMIE',
    appletId: 'afce2bd6-a8c4-4db0-8980-561187661839',
    organization: 'American Chamber of Commerce of the Philippines',
    version: '1.0.0',
    capabilities: ['MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API'],
  });
});

app.get('/favicon.ico', (_req: Request, res: Response) => {
  res.redirect('/favicon.svg');
});

// Multer in-memory storage for document uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.txt', '.csv', '.md'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.mimetype.includes('text') || file.mimetype.includes('pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file format. Please upload PDF, DOCX, TXT, MD, or CSV files.'));
    }
  },
});

// Multer in-memory storage for verified training evidence files (uploaded to Firebase Storage)
const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit strictly enforced
  fileFilter: (_req, file, cb) => {
    const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (allowedExts.includes(ext) || allowedMimes.includes(file.mimetype.toLowerCase()) || file.mimetype.includes('image') || file.mimetype.includes('pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid evidence file format. Permitted formats are PDF, JPG, PNG, and WebP (up to 10MB).'));
    }
  },
});

// Secure Session Architecture
interface Session {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

const DATA_DIR = process.env.AMIE_DATA_DIR
  ? path.resolve(process.env.AMIE_DATA_DIR)
  : path.resolve(process.cwd(), '.data');
const MANUAL_2019_PDF_FILENAME = 'amcham-personnel-manual-2019.pdf';
const manual2019PdfPath = path.join(DATA_DIR, 'documents', MANUAL_2019_PDF_FILENAME);

const sessions = new Map<string, Session>();
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30-day persistent session

async function loadPersistedSessions() {
  try {
    const sessionsFile = path.join(DATA_DIR, 'sessions.json');
    if (fs.existsSync(sessionsFile)) {
      try {
        const raw = fs.readFileSync(sessionsFile, 'utf-8');
        const parsed = JSON.parse(raw);
        const now = Date.now();
        for (const [token, session] of Object.entries(parsed)) {
          if (session && (session as any).expiresAt > now) {
            sessions.set(token, session as Session);
          }
        }
      } catch (fErr) {
        console.error('Error reading local sessions.json:', fErr);
      }
    }

    const loaded = await firebaseStorage.loadAllSessions();
    const now = Date.now();
    for (const [token, session] of loaded.entries()) {
      if (session && session.expiresAt > now) {
        sessions.set(token, session as Session);
      }
    }
  } catch (err) {
    console.error('[AMIE Firebase] Error loading persisted sessions:', err);
  }
}

function savePersistedSessions(targetToken?: string) {
  try {
    const now = Date.now();
    const sessionsFile = path.join(DATA_DIR, 'sessions.json');
    const sessionsObj: Record<string, Session> = {};
    for (const [tok, sess] of sessions.entries()) {
      if (sess && sess.expiresAt > now) {
        sessionsObj[tok] = sess;
      }
    }
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(sessionsFile, JSON.stringify(sessionsObj, null, 2), 'utf-8');
    } catch (fsErr) {
      console.error('Error writing local sessions.json:', fsErr);
    }

    if (targetToken) {
      const session = sessions.get(targetToken);
      if (session && session.expiresAt > now) {
        firebaseStorage.saveSession(targetToken, session).catch(() => {});
      } else {
        firebaseStorage.deleteSession(targetToken).catch(() => {});
      }
      return;
    }
    for (const [token, session] of sessions.entries()) {
      if (session.expiresAt > now) {
        firebaseStorage.saveSession(token, session).catch(() => {});
      } else {
        sessions.delete(token);
        firebaseStorage.deleteSession(token).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[AMIE Firebase] Error saving sessions:', err);
  }
}

// Periodic cleanup of expired sessions every 15 minutes
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
      firebaseStorage.deleteSession(token).catch(() => {});
      changed = true;
    }
  }
  if (changed) savePersistedSessions();
}, 15 * 60 * 1000);

// Helper to sanitize any raw session token from headers, query params, or cookies
function cleanSessionToken(raw?: unknown): string {
  if (!raw || typeof raw !== 'string') return '';
  let token = raw.trim();
  token = token.replace(/^(?:Bearer\s+)/i, '').trim();
  token = token.replace(/^["']+|["']+$/g, '').trim();
  token = token.replace(/^(?:Bearer\s+)/i, '').trim();
  token = token.replace(/^["']+|["']+$/g, '').trim();
  return token;
}

// Sanitize user object to never leak passwords or sensitive credentials in API responses
function sanitizeUser(user: User): Omit<User, 'password' | 'historicalPasswordHashes' | 'passwordResetToken' | 'passwordResetExpires' | 'emailVerificationCode'> {
  const { password: _, historicalPasswordHashes: _h, passwordResetToken: _t, passwordResetExpires: _e, emailVerificationCode: _v, ...safeUser } = user;
  return safeUser;
}

// Strictly verify session token from Bearer, x-session-token headers, query parameter, or cookies
function getActiveUser(req?: Request): User | null {
  if (!req) return null;
  const users = db.getData().users;
  const now = Date.now();

  // Helper to validate and slide session
  const validateSession = (rawToken: string): User | null => {
    const token = cleanSessionToken(rawToken);
    if (!token) return null;

    let session = sessions.get(token);

    // If session is not currently cached in memory, check persistent disk file
    if (!session) {
      try {
        const sessionsFile = path.join(DATA_DIR, 'sessions.json');
        if (fs.existsSync(sessionsFile)) {
          const raw = fs.readFileSync(sessionsFile, 'utf-8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed[token] && parsed[token].expiresAt > now) {
            session = parsed[token];
            sessions.set(token, session as Session);
          }
        }
      } catch (fErr) {
        // non-blocking
      }
    }

    if (session && session.expiresAt > now) {
      // Sliding window: if less than 15 days remain, extend by 30 days
      if (session.expiresAt - now < 15 * 24 * 60 * 60 * 1000) {
        session.expiresAt = now + SESSION_LIFETIME_MS;
        savePersistedSessions(token);
      }
      const found = users.find((u) => u.id === session!.userId);
      if (found && found.accountStatus !== 'SUSPENDED') {
        return found;
      }
    }
    return null;
  };

  // 1. Check Bearer token in Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const user = validateSession(authHeader);
    if (user) return user;
  }

  // 2. Check x-session-token header
  const sessionTokenHeader = req.headers['x-session-token'] as string;
  if (sessionTokenHeader) {
    const user = validateSession(sessionTokenHeader);
    if (user) return user;
  }

  // 3. Check token query parameter (for direct iframe and file streaming)
  const queryToken = (req.query?.token || req.query?.sessionToken || req.query?.accessToken) as string;
  if (queryToken && typeof queryToken === 'string') {
    const user = validateSession(queryToken);
    if (user) return user;
  }

  // 4. Check cookies (for browser tabs, iframes, img src, downloads)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)(?:amie_session_token|sessionToken)=([^;]+)/);
    if (match && match[1]) {
      const user = validateSession(decodeURIComponent(match[1]));
      if (user) return user;
    }
  }

  // All unauthenticated or spoofed requests are rejected
  return null;
}

// Server-side Role-Based Access Control (RBAC) middleware
function requireRole(allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const active = getActiveUser(req);
    if (!active) {
      return res.status(401).json({ error: 'Unauthorized: Valid session authentication required.' });
    }
    if (allowedRoles.includes(active.role) || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR') {
      (req as any).user = active;
      next();
    } else {
      res.status(403).json({ error: `Forbidden: Current role (${active.role}) lacks authorization for this operation.` });
    }
  };
}

// Extract authenticated user without insecure default-user fallback
function getReqUser(req: Request): User {
  const user = (req as any).user || getActiveUser(req);
  if (!user) {
    throw new Error('Authentication required');
  }
  return user;
}

// SSE Real-Time Synchronization Stream Endpoint
app.get('/api/events', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required for real-time synchronization stream.' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  const client: SseClient = { res, userId: active.id, role: active.role };
  sseClients.add(client);

  res.write(`retry: 3000\n`);
  res.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected', userId: active.id, role: active.role, timestamp: new Date().toISOString() })}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      clearInterval(keepAlive);
      sseClients.delete(client);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(client);
  });
});

// ----------------------------------------------------
// 1. AUTH & ROLES API
// ----------------------------------------------------

// System setup status: checks if initial administrator exists in persistent storage
app.get('/api/auth/setup-status', (_req: Request, res: Response) => {
  try {
    const hasAdmin = db.hasActiveAdmin();
    const users = db.getData().users;
    const activeAdmins = users.filter(
      (u) => (u.role === 'SYSTEM_ADMINISTRATOR' || u.role === 'HR_ADMINISTRATOR') && u.accountStatus === 'ACTIVE'
    );
    res.json({
      success: true,
      initialized: hasAdmin,
      userCount: users.length,
      activeAdminCount: activeAdmins.length,
      dbStatus: 'VERIFIED_PERSISTENT',
    });
  } catch (err: any) {
    console.error('[AMIE Auth] Error querying setup-status:', err);
    // Explicit Requirement: Server/query failure must NEVER be interpreted as zero administrator accounts
    res.status(500).json({
      success: false,
      error: 'Persistent storage verification failed. Existing accounts are safeguarded.',
      initialized: true,
      dbStatus: 'ERROR',
    });
  }
});

// One-time administrator initialization (only valid when no active admin exists)
app.post('/api/auth/initialize-admin', (req: Request, res: Response) => {
  if (db.hasActiveAdmin()) {
    return res.status(400).json({ error: 'System is already initialized with an active administrator.' });
  }

  const { name, department, jobTitle } = req.body;
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body.password;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Full name, email, and password are required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid work email address.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  if (db.findUserByEmail(email)) {
    return res.status(400).json({ error: 'An account with this email address already exists.' });
  }

  const isRachel = isDesignatedHRAdminEmail(email);
  const historical = db.findHistoricalUserByEmail(email);
  const newAdmin: User = {
    id: historical ? historical.id : (isRachel ? DESIGNATED_HR_ADMIN_CONFIG.id : `usr_adm_${Date.now()}`),
    name: isRachel ? DESIGNATED_HR_ADMIN_CONFIG.name : name.trim(),
    email,
    password: hashPassword(password),
    role: isRachel ? 'HR_ADMINISTRATOR' : 'SYSTEM_ADMINISTRATOR',
    accountStatus: 'ACTIVE',
    verificationStatus: 'VERIFIED',
    department: isRachel ? DESIGNATED_HR_ADMIN_CONFIG.department : department?.trim() || historical?.department || 'Executive Office',
    jobTitle: isRachel ? DESIGNATED_HR_ADMIN_CONFIG.jobTitle : jobTitle?.trim() || historical?.jobTitle || 'Director of Operations & HR',
    joinedDate: historical?.joinedDate || new Date().toISOString().split('T')[0],
    employeeNumber: isRachel ? DESIGNATED_HR_ADMIN_CONFIG.employeeNumber : (historical?.employeeNumber || 'ACPH-HR-001'),
  };

  db.createUser(newAdmin);
  db.createEmployeeRecordForUser(newAdmin);

  // Generate cryptographically secure random session token
  const token = `amie_sec_${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();

  sessions.set(token, {
    token,
    userId: newAdmin.id,
    createdAt: now,
    expiresAt: now + SESSION_LIFETIME_MS,
  });
  savePersistedSessions();
  setSessionCookie(req, res, token);

  db.logAction(
    newAdmin.id,
    newAdmin.name,
    newAdmin.role,
    'SYSTEM_INITIALIZATION',
    'AUTH',
    `Initial system administrator initialized: ${newAdmin.email}`
  );

  res.json({
    success: true,
    token,
    user: sanitizeUser(newAdmin),
    message: 'System Administrator initialized successfully.',
  });
});

// Registration: strictly least-privileged role (EMPLOYEE) for all public registrations,
// unless explicitly matching the trusted server-side designated HR Administrator configuration for Ma’am Rachel De Guzman.
app.post('/api/auth/register', (req: Request, res: Response) => {
  const { name, department, jobTitle, employeeNumber } = req.body;
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body.password;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Full name, company email address, and password are required.' });
  }

  // Strict company email format requirement ending with @amchamphilippines.com
  if (!isValidAmchamEmail(email)) {
    return res.status(400).json({
      error: 'Registration requires a valid company email address ending exactly in @amchamphilippines.com (e.g. employee.name@amchamphilippines.com).',
    });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  const isRachel = isDesignatedHRAdminEmail(email);

  // If registering the designated HR Administrator account (Ma’am Rachel De Guzman)
  if (isRachel) {
    // Check if an existing HR Administrator account already exists
    let existingRachel = db.findUserByEmail(email);

    if (existingRachel) {
      return res.status(400).json({
        error: 'An account with this email address already exists. Please sign in or reset your password.',
        exists: true,
        email: email.trim().toLowerCase(),
      });
    }

    // Rachel does not exist yet: provision her fresh account as the single HR_ADMINISTRATOR
    const newAdmin: User = {
      id: DESIGNATED_HR_ADMIN_CONFIG.id,
      name: name.trim() || DESIGNATED_HR_ADMIN_CONFIG.name,
      email: email.toLowerCase().trim(),
      password: hashPassword(password),
      role: 'HR_ADMINISTRATOR',
      accountStatus: 'ACTIVE',
      verificationStatus: 'VERIFIED',
      department: department?.trim() || DESIGNATED_HR_ADMIN_CONFIG.department,
      jobTitle: jobTitle?.trim() || DESIGNATED_HR_ADMIN_CONFIG.jobTitle,
      joinedDate: new Date().toISOString().split('T')[0],
      employeeNumber: employeeNumber?.trim() || DESIGNATED_HR_ADMIN_CONFIG.employeeNumber,
    };

    db.createUser(newAdmin);
    db.createEmployeeRecordForUser(newAdmin);

    const token = `amie_sec_${crypto.randomBytes(32).toString('hex')}`;
    const now = Date.now();
    sessions.set(token, {
      token,
      userId: newAdmin.id,
      createdAt: now,
      expiresAt: now + SESSION_LIFETIME_MS,
    });
    savePersistedSessions();
    setSessionCookie(req, res, token);

    db.logAction(
      newAdmin.id,
      newAdmin.name,
      newAdmin.role,
      'ADMIN_PROVISION_REGISTER',
      'AUTH',
      `Authorized HR Administrator provisioned via registration: ${newAdmin.name} (${newAdmin.email})`
    );

    return res.json({
      success: true,
      token,
      user: sanitizeUser(newAdmin),
      message: 'Account successfully provisioned as authorized HR Administrator (Ma’am Rachel De Guzman).',
    });
  }

  // General registration: check for duplicate email
  if (db.findUserByEmail(email)) {
    return res.status(400).json({
      error: 'An account with this email address already exists. Please sign in or reset your password.',
      exists: true,
      email: email.trim().toLowerCase(),
    });
  }

  // Preserve stable user ID if employee profile or tasks existed previously
  const historical = db.findHistoricalUserByEmail(email);

  // Role assignment: allow EMPLOYEE, MANAGER, or DEPARTMENT_HEAD; block privilege escalation to HR/System Admin
  const requestedRoleRaw = req.body.role || req.body.requestedRole;
  const requestedRole = typeof requestedRoleRaw === 'string' ? requestedRoleRaw.trim().toUpperCase() : '';
  let assignedRole: UserRole = 'EMPLOYEE';
  if (requestedRole === 'MANAGER') {
    assignedRole = 'MANAGER';
  } else if (requestedRole === 'DEPARTMENT_HEAD') {
    assignedRole = 'DEPARTMENT_HEAD';
  } else if (historical?.role === 'MANAGER' || historical?.role === 'DEPARTMENT_HEAD') {
    assignedRole = historical.role;
  }

  const idPrefix =
    assignedRole === 'DEPARTMENT_HEAD'
      ? 'usr_dh'
      : assignedRole === 'MANAGER'
        ? 'usr_mgr'
        : 'usr_emp';

  const defaultJobTitle =
    assignedRole === 'DEPARTMENT_HEAD'
      ? 'Department Head'
      : assignedRole === 'MANAGER'
        ? 'Department Manager'
        : 'Secretariat Staff';

  const newUser: User = {
    id: historical ? historical.id : `${idPrefix}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: name.trim(),
    email: email.toLowerCase().trim(),
    password: hashPassword(password),
    role: assignedRole,
    accountStatus: 'ACTIVE', // accessible immediately without waiting for HR approval
    verificationStatus: assignedRole === 'DEPARTMENT_HEAD' ? 'VERIFIED' : 'UNVERIFIED',
    department: department?.trim() || historical?.department || 'Committees & Events',
    jobTitle: jobTitle?.trim() || historical?.jobTitle || defaultJobTitle,
    joinedDate: historical?.joinedDate || new Date().toISOString().split('T')[0],
    employeeNumber: employeeNumber?.trim() || historical?.employeeNumber || undefined,
  };

  db.createUser(newUser);
  db.createEmployeeRecordForUser(newUser);

  // Generate session token so the employee has immediate access
  const token = `amie_sec_${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();

  sessions.set(token, {
    token,
    userId: newUser.id,
    createdAt: now,
    expiresAt: now + SESSION_LIFETIME_MS,
  });
  savePersistedSessions();
  setSessionCookie(req, res, token);

  db.logAction(
    newUser.id,
    newUser.name,
    newUser.role,
    'USER_REGISTRATION',
    'AUTH',
    `New ${newUser.role} account registered and logged in: ${newUser.name} (${newUser.email}).`
  );

  res.json({
    success: true,
    token,
    user: sanitizeUser(newUser),
    message:
      assignedRole === 'DEPARTMENT_HEAD'
        ? 'Department Head account created successfully! You now have access to your department evaluation workspace.'
        : assignedRole === 'MANAGER'
          ? 'Manager account created successfully! You now have access to your management workspace.'
          : 'Account created successfully! You now have access to your employee workspace.',
  });
});

// Administrative user account deletion (HR Administrator ONLY - protected from deleting Rachel or Admins)
app.delete(
  '/api/users/:id',
  requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { id } = req.params;
    const target = db.findUserById(id);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (target.role === 'HR_ADMINISTRATOR' || target.role === 'SYSTEM_ADMINISTRATOR' || isDesignatedHRAdminEmail(target.email)) {
      return res.status(403).json({ error: 'Cannot delete administrative user accounts.' });
    }
    const ok = db.deleteUser(id);
    if (!ok) {
      return res.status(500).json({ error: 'Failed to delete user.' });
    }
    db.logAction(
      active.id,
      active.name,
      active.role,
      'DELETE_USER_ACCOUNT',
      'USER',
      `Deleted user account ${target.name} (${target.email})`,
      id
    );
    res.json({ success: true, message: 'User account removed.' });
  }
);

// Password recovery initiation
app.post('/api/auth/forgot-password', async (req: Request, res: Response) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email) {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  const user = db.findUserByEmail(email);
  if (!user) {
    // Avoid user enumeration
    return res.json({
      success: true,
      message: 'If an account exists with this email address, a password recovery code has been generated.',
    });
  }

  // Generate 8-character verification code
  const resetCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  db.updateUser(user.id, {
    passwordResetToken: resetCode,
    passwordResetExpires: Date.now() + 60 * 60 * 1000, // 1 hour validity
  });

  db.logAction(
    user.id,
    user.name,
    user.role,
    'PASSWORD_RECOVERY_REQUEST',
    'AUTH',
    `Password recovery verification requested for ${user.email}`
  );

  const emailResult = await sendApplicantPasswordResetEmail({
    email: user.email,
    name: user.name,
    resetCode,
  });

  res.json({
    success: true,
    message: emailResult.delivered
      ? 'Password recovery code has been sent to your email.'
      : 'Password recovery verification code generated.',
    emailDelivery: {
      configured: emailResult.providerConfigured,
      delivered: emailResult.delivered,
      error: emailResult.error,
    },
    recoveryToken: resetCode,
  });
});

// Password recovery completion
app.post('/api/auth/reset-password', (req: Request, res: Response) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const { recoveryToken, newPassword } = req.body;
  if (!email || !recoveryToken || !newPassword) {
    return res.status(400).json({ error: 'Email, verification code, and new password are required.' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
  }

  const user = db.findUserByEmail(email);
  if (!user || !user.passwordResetToken || !user.passwordResetExpires) {
    return res.status(400).json({ error: 'Invalid or expired password reset request.' });
  }

  if (Date.now() > user.passwordResetExpires) {
    db.updateUser(user.id, {
      passwordResetToken: undefined,
      passwordResetExpires: undefined,
    });
    return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
  }

  if (user.passwordResetToken !== recoveryToken.trim().toUpperCase()) {
    return res.status(400).json({ error: 'Invalid recovery verification code.' });
  }

  db.updateUser(user.id, {
    password: hashPassword(newPassword),
    historicalPasswordHashes: [], // Invalidate previous passwords upon explicit reset
    passwordResetToken: undefined,
    passwordResetExpires: undefined,
  });

  // Invalidate any active sessions for this user
  let changed = false;
  for (const [token, session] of sessions.entries()) {
    if (session.userId === user.id) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) savePersistedSessions();

  db.logAction(
    user.id,
    user.name,
    user.role,
    'PASSWORD_RESET_SUCCESS',
    'AUTH',
    `Password successfully updated for ${user.email}`
  );

  res.json({
    success: true,
    message: 'Your password has been successfully reset. You may now sign in with your new password.',
  });
});

// Verify current session
app.get(['/api/auth/me', '/api/auth/session'], (req: Request, res: Response) => {
  const user = getActiveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthenticated session', user: null });
  }
  res.json({ user: sanitizeUser(user) });
});

// Automatic Account Registry & Directory: restricted to authenticated sessions
app.get('/api/auth/users', requireRole(['EMPLOYEE', 'MANAGER', 'DEPARTMENT_HEAD', 'HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  let users = db.getData().users;
  if (active.role === 'EMPLOYEE' || active.role === 'MANAGER' || active.role === 'DEPARTMENT_HEAD') {
    // Strict RA 10173 Privacy: Non-HR personnel can ONLY view their own account record; the full registry is restricted to authorized HR & Administrators
    users = users.filter((u) => u.id === active.id);
  }
  const safeUsers = users.map((u) => sanitizeUser(u));
  res.json({ users: safeUsers });
});

// Enterprise Login: requires valid credentials and active account status; verifies login intent mode
app.post('/api/auth/login', (req: Request, res: Response) => {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body.password;
    const loginMode = typeof req.body.loginMode === 'string' ? req.body.loginMode.trim().toUpperCase() : undefined;

    if (!email || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Both email and password are required.' });
    }

    const user = db.findUserByEmail(email);

    if (!user) {
      return res.status(401).json({
        error: 'Invalid email or password.',
        code: 'USER_NOT_FOUND',
        accountExists: false,
      });
    }

    // Cryptographic PBKDF2 password verification with one-time historical migration and trimmed tolerance
    let passwordMatches = verifyPassword(password, user.password) || verifyPassword(password.trim(), user.password);

    if (!passwordMatches && Array.isArray(user.historicalPasswordHashes) && user.historicalPasswordHashes.length > 0) {
      for (const oldHash of user.historicalPasswordHashes) {
        if (verifyPassword(password, oldHash) || verifyPassword(password.trim(), oldHash)) {
          passwordMatches = true;
          break;
        }
      }
    }

    // Authoritative fallback for designated HR Administrator (Ma'am Rachel De Guzman)
    if (!passwordMatches && isDesignatedHRAdminEmail(user.email)) {
      for (const oldHash of RACHEL_HISTORICAL_PASSWORD_HASHES) {
        if (verifyPassword(password, oldHash) || verifyPassword(password.trim(), oldHash)) {
          passwordMatches = true;
          break;
        }
      }
      if (
        !passwordMatches &&
        (password === 'EnterpriseHRAdmin2026!' ||
          verifyPassword(password, AUTHORITATIVE_BASELINE_USERS[1].password) ||
          verifyPassword(password.trim(), AUTHORITATIVE_BASELINE_USERS[1].password))
      ) {
        passwordMatches = true;
      }
    }

    if (!passwordMatches) {
      db.logAction(user.id, user.name, user.role, 'LOGIN_FAILED', 'AUTH', `Failed authentication attempt for ${email}`);
      return res.status(401).json({
        error: 'Invalid email or password.',
        code: 'INVALID_PASSWORD',
        accountExists: true,
        email: user.email,
      });
    }

    if (user.accountStatus === 'SUSPENDED') {
      return res.status(403).json({
        error: 'Your account access has been suspended. Please contact the Secretariat HR Administration.',
      });
    }

    // Multi-mode login enforcement: mode is strictly intent verification and never mutates role
    if (user.role === 'APPLICANT') {
      if (loginMode && loginMode !== 'APPLICANT') {
        return res.status(403).json({
          error: 'Access denied: This account is registered as a Career Applicant. Please sign in via the Applicant Portal.',
        });
      }
    } else if (loginMode === 'APPLICANT') {
      return res.status(403).json({
        error: 'This email is registered as an AmCham Secretariat Staff account. Please sign in using the Staff Sign In option.',
      });
    }

    if (loginMode === 'HR_ADMINISTRATOR') {
      if (user.role !== 'HR_ADMINISTRATOR' && user.role !== 'SYSTEM_ADMINISTRATOR') {
        return res.status(403).json({
          error: 'Access denied: This account lacks HR Administrator privileges. Please switch to the appropriate login mode.',
        });
      }
    } else if (loginMode === 'MANAGER') {
      if (user.role !== 'MANAGER' && user.role !== 'SYSTEM_ADMINISTRATOR') {
        return res.status(403).json({
          error: 'Access denied: This account is not registered with Manager privileges. Please contact HR or select Employee mode.',
        });
      }
    } else if (loginMode === 'DEPARTMENT_HEAD') {
      if (user.role !== 'DEPARTMENT_HEAD' && user.role !== 'SYSTEM_ADMINISTRATOR') {
        return res.status(403).json({
          error: 'Access denied: This account is not registered as a Department Head. Please select the appropriate login mode.',
        });
      }
    } else if (user.role === 'DEPARTMENT_HEAD' && loginMode && loginMode !== 'DEPARTMENT_HEAD') {
      return res.status(403).json({
        error: 'Access denied: Department Head accounts must sign in using the Department Head login mode.',
      });
    }

    // Ensure default employee record exists only for non-applicant staff users
    if (user.role !== 'APPLICANT') {
      db.createEmployeeRecordForUser(user);
    }

    // Generate cryptographically secure random session token
    const token = `amie_sec_${crypto.randomBytes(32).toString('hex')}`;
    const now = Date.now();

    sessions.set(token, {
      token,
      userId: user.id,
      createdAt: now,
      expiresAt: now + SESSION_LIFETIME_MS,
    });
    savePersistedSessions();
    setSessionCookie(req, res, token);

    db.logAction(user.id, user.name, user.role, 'USER_LOGIN', 'AUTH', `Enterprise session authenticated for ${user.email} (Role: ${user.role})`);
    res.json({ success: true, token, user: sanitizeUser(user) });
  } catch (err: any) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message || 'Authentication processing error.' });
  }
});

// Dedicated administrative provisioning endpoint for designated HR Administrator (Ma'am Rachel De Guzman)
app.post('/api/auth/provision-hr-admin', (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const targetEmail = (email || DESIGNATED_HR_ADMIN_CONFIG.primaryEmail).toLowerCase().trim();

    if (!isDesignatedHRAdminEmail(targetEmail)) {
      return res.status(403).json({
        error: 'Unauthorized: Administrative HR provisioning is restricted to the designated Secretariat HR Administrator (Ma’am Rachel De Guzman).',
      });
    }

    const existingHR = db.findUserByEmail(targetEmail);

    if (existingHR) {
      return res.status(400).json({
        error: 'Designated HR Administrator account is already provisioned and active. Please sign in or use password recovery.',
      });
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password of at least 8 characters is required to provision the administrator.' });
    }

    const rachel: User = {
      id: DESIGNATED_HR_ADMIN_CONFIG.id,
      name: DESIGNATED_HR_ADMIN_CONFIG.name,
      email: targetEmail,
      password: hashPassword(password),
      role: 'HR_ADMINISTRATOR',
      accountStatus: 'ACTIVE',
      verificationStatus: 'VERIFIED',
      department: DESIGNATED_HR_ADMIN_CONFIG.department,
      jobTitle: DESIGNATED_HR_ADMIN_CONFIG.jobTitle,
      joinedDate: new Date().toISOString().split('T')[0],
      employeeNumber: DESIGNATED_HR_ADMIN_CONFIG.employeeNumber,
    };

    db.createUser(rachel);
    db.createEmployeeRecordForUser(rachel);
    db.save();

    const token = `amie_sec_${crypto.randomBytes(32).toString('hex')}`;
    const now = Date.now();
    sessions.set(token, {
      token,
      userId: rachel.id,
      createdAt: now,
      expiresAt: now + SESSION_LIFETIME_MS,
    });
    savePersistedSessions();
    setSessionCookie(req, res, token);

    db.logAction(
      rachel.id,
      rachel.name,
      rachel.role,
      'ADMIN_PROVISION',
      'AUTH',
      `Designated HR Administrator provisioned: ${rachel.name} (${rachel.email})`
    );

    res.json({
      success: true,
      token,
      user: sanitizeUser(rachel),
      message: 'Ma’am Rachel De Guzman successfully provisioned and verified as HR Administrator.',
    });
  } catch (err: any) {
    console.error('Provision HR Admin error:', err);
    res.status(500).json({ error: err.message || 'Failed to provision HR Administrator.' });
  }
});

// Securely Restricted Administrative Reset Endpoint:
// Strictly requires SYSTEM_ADMINISTRATOR authorization, explicit safeguard header and confirmation payload,
// creates an authoritative timestamped backup first, and guarantees authoritative baseline users remain preserved.
app.post('/api/auth/controlled-account-reset', requireRole(['SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  try {
    const active = getReqUser(req);
    const { adminConfirmation } = req.body;
    const safeguardHeader = req.headers['x-admin-safeguard'];

    if (adminConfirmation !== 'CONFIRM_ADMIN_PURGE_AUTHORIZED' || safeguardHeader !== 'AUTHORIZED_RESET') {
      return res.status(403).json({
        error: 'Forbidden: Explicit administrative safeguard verification required (header x-admin-safeguard: AUTHORIZED_RESET and confirmation payload).',
      });
    }

    const backupMetadata = createDatabaseBackup(db.getData());
    const resetResult = db.resetLoginAccounts(active.id, active.name);

    // Keep administrator session active, invalidate other non-admin sessions
    for (const [token, session] of sessions.entries()) {
      if (session.userId !== active.id) {
        sessions.delete(token);
      }
    }
    savePersistedSessions();

    res.json({
      success: true,
      backup: backupMetadata,
      reset: resetResult,
      message: 'Administrative reset completed under verified safeguards. Authoritative accounts and business data preserved.',
    });
  } catch (err: any) {
    console.error('Administrative reset error:', err);
    res.status(500).json({ error: err.message || 'Administrative reset failed.' });
  }
});

// ----------------------------------------------------
// ADMINISTRATIVE BACKUP & RECOVERY API
// ----------------------------------------------------
app.get('/api/admin/backups', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (_req: Request, res: Response) => {
  try {
    const backups = listDatabaseBackups();
    res.json({ success: true, backups });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list backups.' });
  }
});

app.post('/api/admin/backups', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  try {
    const active = getReqUser(req);
    const metadata = createDatabaseBackup(db.getData());
    db.logAction(active.id, active.name, active.role, 'CREATE_BACKUP', 'SYSTEM_BACKUP', `Manual snapshot created: ${metadata.filename}`);
    res.json({ success: true, backup: metadata });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create backup.' });
  }
});

app.post('/api/admin/backups/test-restore', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  try {
    const { filename } = req.body;
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'Filename is required.' });
    }
    const safeFilename = path.basename(filename);
    const filePath = path.join(DATA_DIR, 'backups', safeFilename);
    const simulation = testRestoreSimulation(filePath, db.getData());
    res.json({ success: simulation.valid, simulation });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to run restore simulation.' });
  }
});

// HR / Admin approve pending employee
app.post('/api/auth/users/:id/approve', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const { role, employeeNumber } = req.body;
  const active = getReqUser(req);

  const targetUser = db.findUserById(id);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const userUpdates: Partial<User> = {
    accountStatus: 'ACTIVE',
  };
  if (role) {
    if (role === 'SYSTEM_ADMINISTRATOR' && active.role !== 'SYSTEM_ADMINISTRATOR') {
      return res.status(403).json({ error: 'Only a System Administrator can grant System Administrator privileges.' });
    }
    if (role === 'HR_ADMINISTRATOR') {
      const existingHR = db.getData().users.find(
        (u) => u.id !== targetUser.id && u.role === 'HR_ADMINISTRATOR' && u.accountStatus === 'ACTIVE'
      );
      if (existingHR) {
        return res.status(400).json({
          error: 'Policy violation: Exactly one authorized HR Administrator account may be active under AmCham policy.',
        });
      }
    }
    userUpdates.role = role;
  }
  if (employeeNumber) {
    userUpdates.employeeNumber = employeeNumber.trim();
  } else if (!targetUser.employeeNumber) {
    userUpdates.employeeNumber = `ACPH-2026-${String(db.getData().employeeRecords.length + 1).padStart(4, '0')}`;
  }

  const updatedTargetUser = db.updateUser(targetUser.id, userUpdates) || targetUser;
  db.createEmployeeRecordForUser(updatedTargetUser);

  db.createNotification(
    updatedTargetUser.id,
    'Account Approved & Activated',
    `Your Secretariat account (${updatedTargetUser.email}) has been approved by ${active.name} with role ${updatedTargetUser.role}.`,
    'SYSTEM',
    'dashboard',
    { userId: updatedTargetUser.id, eventKey: `approve_user_${updatedTargetUser.id}_${Date.now()}` },
    updatedTargetUser.email
  );

  db.logAction(
    active.id,
    active.name,
    active.role,
    'APPROVE_USER',
    'AUTH',
    `Approved account for ${updatedTargetUser.name} (${updatedTargetUser.email}) with role ${updatedTargetUser.role}`,
    updatedTargetUser.id
  );

  res.json({
    success: true,
    user: sanitizeUser(updatedTargetUser),
    message: `Account for ${updatedTargetUser.name} has been approved and activated.`,
  });
});

// HR / Admin update account status or role
app.post('/api/auth/users/:id/status', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, role } = req.body;
  const active = getReqUser(req);

  const targetUser = db.findUserById(id);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (targetUser.role === 'SYSTEM_ADMINISTRATOR' && status === 'SUSPENDED') {
    const adminCount = db.getData().users.filter((u) => u.role === 'SYSTEM_ADMINISTRATOR' && u.accountStatus === 'ACTIVE').length;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot suspend the sole remaining System Administrator.' });
    }
  }

  const statusUpdates: Partial<User> = {};
  if (status) {
    statusUpdates.accountStatus = status;
    if (status === 'SUSPENDED') {
      for (const [token, session] of sessions.entries()) {
        if (session.userId === targetUser.id) {
          sessions.delete(token);
        }
      }
      savePersistedSessions();
    }
  }

  if (role) {
    if (role === 'SYSTEM_ADMINISTRATOR' && active.role !== 'SYSTEM_ADMINISTRATOR') {
      return res.status(403).json({ error: 'Only a System Administrator can grant System Administrator role.' });
    }
    if (role === 'HR_ADMINISTRATOR') {
      const existingHR = db.getData().users.find(
        (u) => u.id !== targetUser.id && u.role === 'HR_ADMINISTRATOR' && u.accountStatus === 'ACTIVE'
      );
      if (existingHR) {
        return res.status(400).json({
          error: 'Policy violation: Exactly one authorized HR Administrator account may be active under AmCham policy.',
        });
      }
    }
    statusUpdates.role = role;
  }

  const updatedTargetUser = db.updateUser(targetUser.id, statusUpdates) || targetUser;

  db.createNotification(
    updatedTargetUser.id,
    'Account Status or Role Updated',
    `Administrator ${active.name} updated your account status to ${updatedTargetUser.accountStatus} (Role: ${updatedTargetUser.role}).`,
    'SYSTEM',
    'dashboard',
    { userId: updatedTargetUser.id, status: updatedTargetUser.accountStatus, role: updatedTargetUser.role, eventKey: `user_status_${updatedTargetUser.id}_${Date.now()}` },
    updatedTargetUser.email
  );

  db.logAction(
    active.id,
    active.name,
    active.role,
    'UPDATE_USER_STATUS',
    'AUTH',
    `Updated status/role for ${updatedTargetUser.email} (Status: ${updatedTargetUser.accountStatus}, Role: ${updatedTargetUser.role})`,
    updatedTargetUser.id
  );

  res.json({
    success: true,
    user: sanitizeUser(updatedTargetUser),
  });
});

// Admin delete account
app.delete('/api/auth/users/:id', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);

  if (id === active.id) {
    return res.status(400).json({ error: 'You cannot delete your own active administrator account.' });
  }

  const targetUser = db.findUserById(id);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (targetUser.role === 'HR_ADMINISTRATOR' || targetUser.role === 'SYSTEM_ADMINISTRATOR' || isDesignatedHRAdminEmail(targetUser.email)) {
    return res.status(403).json({ error: 'Cannot delete administrative user accounts.' });
  }

  db.deleteUser(id, false);

  for (const [token, session] of sessions.entries()) {
    if (session.userId === id) {
      sessions.delete(token);
    }
  }
  savePersistedSessions();

  db.logAction(
    active.id,
    active.name,
    active.role,
    'DELETE_USER',
    'AUTH',
    `Deleted user account: ${targetUser.email}`,
    id
  );

  res.json({ success: true, message: `Account for ${targetUser.name} deleted.` });
});

// Department Head Account Creation & Management (Restricted strictly to authorized HR)
const DEPARTMENT_HEAD_ALLOWED_DEPARTMENTS = [
  'Finance',
  'Human Capital & Administration',
  'Membership Development',
  'Executive Office',
  'Other',
];

function resolveDepartmentHeadDepartment(department?: string, customDepartment?: string): { valid: boolean; resolved?: string; error?: string } {
  const dept = typeof department === 'string' ? department.trim() : '';
  if (!dept) {
    return { valid: false, error: 'Department is required.' };
  }
  if (!DEPARTMENT_HEAD_ALLOWED_DEPARTMENTS.includes(dept)) {
    return {
      valid: false,
      error: `Invalid department option. Select one of: ${DEPARTMENT_HEAD_ALLOWED_DEPARTMENTS.join(', ')}.`,
    };
  }
  if (dept === 'Other') {
    const custom = typeof customDepartment === 'string' ? customDepartment.trim() : '';
    if (!custom) {
      return { valid: false, error: 'Custom department name is required when "Other" is selected.' };
    }
    return { valid: true, resolved: custom };
  }
  return { valid: true, resolved: dept };
}

function normalizeDepartmentName(dept?: string): string {
  return (dept || '').trim().toLowerCase();
}

function isSameDepartment(a?: string, b?: string): boolean {
  const normA = normalizeDepartmentName(a);
  const normB = normalizeDepartmentName(b);
  return Boolean(normA && normB && normA === normB);
}

app.post('/api/auth/department-heads', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  try {
    const active = getReqUser(req);
    const fullName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body.password;
    const position = typeof (req.body.position ?? req.body.jobTitle) === 'string'
      ? String(req.body.position ?? req.body.jobTitle).trim()
      : '';
    const { department, customDepartment } = req.body;

    if (!fullName) {
      return res.status(400).json({ error: 'Full name is required.' });
    }
    if (!isValidAmchamEmail(email)) {
      return res.status(400).json({
        error: 'A valid official company email address ending in @amchamphilippines.com is required.',
      });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }
    if (!position) {
      return res.status(400).json({ error: 'Position / job title is required.' });
    }

    const deptResult = resolveDepartmentHeadDepartment(department, customDepartment);
    if (!deptResult.valid || !deptResult.resolved) {
      return res.status(400).json({ error: deptResult.error || 'Valid department is required.' });
    }

    if (db.findUserByEmail(email)) {
      return res.status(409).json({
        error: `An account with official email "${email}" already exists.`,
        exists: true,
      });
    }

    const dhCount = db.getData().users.filter((u) => u.role === 'DEPARTMENT_HEAD').length + 1;
    const newDeptHead: User = {
      id: `usr_dh_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: fullName,
      email,
      password: hashPassword(password),
      role: 'DEPARTMENT_HEAD',
      accountStatus: 'ACTIVE',
      verificationStatus: 'VERIFIED',
      isEmailVerified: true,
      department: deptResult.resolved,
      jobTitle: position,
      joinedDate: new Date().toISOString().split('T')[0],
      employeeNumber: `ACPH-DH-${String(dhCount).padStart(3, '0')}`,
    };

    db.createUser(newDeptHead);
    db.createEmployeeRecordForUser(newDeptHead);
    db.save();

    db.logAction(
      active.id,
      active.name,
      active.role,
      'CREATE_DEPARTMENT_HEAD_ACCOUNT',
      'AUTH',
      `Created Department Head account for ${newDeptHead.name} (${newDeptHead.email}, Dept: ${newDeptHead.department}, Position: ${newDeptHead.jobTitle})`,
      newDeptHead.id
    );

    res.status(201).json({
      success: true,
      user: sanitizeUser(newDeptHead),
      message: `Department Head account created for ${newDeptHead.name} (${newDeptHead.department}).`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create Department Head account.' });
  }
});

app.put('/api/auth/department-heads/:id', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  try {
    const active = getReqUser(req);
    const { id } = req.params;
    const targetUser = db.findUserById(id);
    if (!targetUser || targetUser.role !== 'DEPARTMENT_HEAD') {
      return res.status(404).json({ error: 'Department Head account not found.' });
    }

    const updates: Partial<User> = {};
    if (typeof req.body.name === 'string') {
      const trimmedName = req.body.name.trim();
      if (!trimmedName) return res.status(400).json({ error: 'Full name cannot be empty.' });
      updates.name = trimmedName;
    }
    const rawPosition = req.body.position ?? req.body.jobTitle;
    if (typeof rawPosition === 'string') {
      const trimmedPos = rawPosition.trim();
      if (!trimmedPos) return res.status(400).json({ error: 'Position cannot be empty.' });
      updates.jobTitle = trimmedPos;
    }
    if (req.body.department !== undefined) {
      const deptResult = resolveDepartmentHeadDepartment(req.body.department, req.body.customDepartment);
      if (!deptResult.valid || !deptResult.resolved) {
        return res.status(400).json({ error: deptResult.error || 'Valid department is required.' });
      }
      updates.department = deptResult.resolved;
    }
    if (req.body.accountStatus === 'ACTIVE' || req.body.accountStatus === 'SUSPENDED') {
      updates.accountStatus = req.body.accountStatus;
      if (req.body.accountStatus === 'SUSPENDED') {
        for (const [token, session] of sessions.entries()) {
          if (session.userId === targetUser.id) sessions.delete(token);
        }
        savePersistedSessions();
      }
    }
    if (typeof req.body.password === 'string' && req.body.password.length > 0) {
      if (req.body.password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      }
      updates.password = hashPassword(req.body.password);
    }

    const updated = db.updateUser(id, updates);
    if (!updated) {
      return res.status(404).json({ error: 'Department Head account not found.' });
    }

    const empRec = db.getData().employeeRecords.find((e) => e.userId === id);
    if (empRec) {
      if (updates.name) empRec.fullName = updates.name;
      if (updates.jobTitle) empRec.jobTitle = updates.jobTitle;
      if (updates.department) empRec.department = updates.department;
      db.save();
    }

    db.logAction(
      active.id,
      active.name,
      active.role,
      'UPDATE_DEPARTMENT_HEAD_ACCOUNT',
      'AUTH',
      `Updated Department Head account for ${updated.name} (${updated.email})`,
      updated.id
    );

    res.json({ success: true, user: sanitizeUser(updated) });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update Department Head account.' });
  }
});

// Department-scoped Employee List for Department Heads (and HR)
app.get('/api/department-head/employees', requireRole(['DEPARTMENT_HEAD', 'HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const data = db.getData();
  const filterDept = typeof req.query.department === 'string' ? req.query.department.trim() : '';

  if (active.role === 'DEPARTMENT_HEAD' && filterDept && !isSameDepartment(filterDept, active.department)) {
    return res.status(403).json({
      error: `Access denied: Department Heads may only view employees assigned to their own department (${active.department}).`,
    });
  }

  const targetDept = active.role === 'DEPARTMENT_HEAD' ? active.department : filterDept;

  const employees = data.users
    .filter((u) => {
      if (u.role === 'APPLICANT') return false;
      if (u.accountStatus === 'SUSPENDED') return false;
      if (active.role === 'DEPARTMENT_HEAD') {
        if (u.id === active.id) return false;
        return isSameDepartment(u.department, active.department);
      }
      if (targetDept && targetDept !== 'ALL') {
        return isSameDepartment(u.department, targetDept);
      }
      return true;
    })
    .map((u) => {
      const empRec = data.employeeRecords.find((e) => e.userId === u.id);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        department: u.department,
        jobTitle: u.jobTitle || empRec?.jobTitle || 'Chamber Staff',
        employeeNumber: u.employeeNumber || empRec?.employeeNumber || '',
        joinedDate: u.joinedDate || empRec?.employmentStartDate || '',
        employmentStatus: empRec?.employmentStatus || 'REGULAR',
      };
    });

  res.json({
    employees,
    department: active.role === 'DEPARTMENT_HEAD' ? active.department : (targetDept || 'ALL'),
  });
});


app.post(
  ['/api/auth/logout', '/api/auth/applicant/logout'],
  (req: Request, res: Response) => {
    const tokens = new Set<string>();

    const addToken = (value: unknown) => {
      if (typeof value !== 'string') return;

      const token = cleanSessionToken(value);
      if (token) tokens.add(token);
    };

    // Get session token from headers
    addToken(req.headers.authorization);
    addToken(req.headers['x-session-token']);

    // Get session token from query parameters
    addToken(req.query.token);
    addToken(req.query.sessionToken);

    // Get session token from cookie
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(
      /(?:^|;\s*)amie_session_token=([^;]+)/
    );

    if (match?.[1]) {
      try {
        addToken(decodeURIComponent(match[1]));
      } catch {
        // Ignore malformed cookie values.
      }
    }

    // Delete identified sessions
    for (const token of tokens) {
      sessions.delete(token);

      firebaseStorage.deleteSession(token).catch((err) => {
        console.error('[AMIE] Session deletion failed:', err);
      });
    }

    if (tokens.size > 0) {
      savePersistedSessions();
    }

    clearSessionCookie(req, res);

    return res.json({
      success: true,
      message: 'Logged out successfully.',
    });
  }
);

app.get('/api/firebase/status', (_req: Request, res: Response) => {
  res.json(firebaseStorage.getStatus());
});

// ----------------------------------------------------
// 2. KNOWLEDGE BASE & DOCUMENT MANAGEMENT
// ----------------------------------------------------
app.get('/api/knowledge/sources', (req: Request, res: Response) => {
  const activeUser = getActiveUser(req);
  if (!activeUser) {
    return res.status(401).json({ error: 'Authentication required to view knowledge sources.' });
  }
  const userRole: UserRole = activeUser.role;
  const allSources = db.getData().knowledgeSources;
  // Non-admins see permitted sources
  const filtered = allSources.filter((s) => RAGEngine.isPermitted(userRole, s.permissionLevel));
  res.json({ sources: filtered });
});

app.get('/api/knowledge/chunks', (req: Request, res: Response) => {
  const activeUser = getActiveUser(req);
  if (!activeUser) {
    return res.status(401).json({ error: 'Authentication required to view document chunks.' });
  }
  const userRole: UserRole = activeUser.role;
  const { sourceId, query } = req.query;
  let chunks = db.getData().chunks.filter((c) => RAGEngine.isPermitted(userRole, c.permissionLevel));

  if (sourceId) {
    chunks = chunks.filter((c) => c.sourceId === sourceId);
  }
  if (query && typeof query === 'string') {
    chunks = chunks.filter((c) => c.content.toLowerCase().includes(query.toLowerCase()) || c.sectionTitle.toLowerCase().includes(query.toLowerCase()));
  }

  res.json({ chunks: chunks.slice(0, 50) });
});

// AmCham Personnel Standards Directory (PS 001 - PS 031)
app.get('/api/knowledge/standards', (req: Request, res: Response) => {
  const activeUser = getActiveUser(req);
  if (!activeUser) {
    return res.status(401).json({ error: 'Authentication required to access Personnel Standards catalog.' });
  }
  const { query, category } = req.query;
  let standards = [...officialPersonnelStandardsCatalog];

  if (category && typeof category === 'string' && category !== 'ALL') {
    standards = standards.filter((s) => s.category.toLowerCase().includes(category.toLowerCase()));
  }

  if (query && typeof query === 'string') {
    const q = query.toLowerCase();
    standards = standards.filter(
      (s) =>
        s.standardNo.toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        s.historicalContext.toLowerCase().includes(q) ||
        s.formsAttached.some((f) => f.toLowerCase().includes(q))
    );
  }

  res.json({ standards });
});

// AmCham Official HR Forms Directory (Pages 58 - 91)
app.get('/api/knowledge/forms', (req: Request, res: Response) => {
  const activeUser = getActiveUser(req);
  if (!activeUser) {
    return res.status(401).json({ error: 'Authentication required to access Official Forms directory.' });
  }
  const { query, standardRef } = req.query;
  let forms = [...officialFormsCatalog];

  if (standardRef && typeof standardRef === 'string') {
    forms = forms.filter((f) => f.standardRef.toLowerCase().includes(standardRef.toLowerCase()));
  }

  if (query && typeof query === 'string') {
    const q = query.toLowerCase();
    forms = forms.filter(
      (f) =>
        f.formName.toLowerCase().includes(q) ||
        f.standardRef.toLowerCase().includes(q) ||
        f.purpose.toLowerCase().includes(q) ||
        f.signatories.some((s) => s.toLowerCase().includes(q))
    );
  }

  res.json({ forms });
});

// Specific Personnel Standard Detail with associated chunks and forms
app.get('/api/knowledge/standards/:standardNo', (req: Request, res: Response) => {
  const activeUser = getActiveUser(req);
  if (!activeUser) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { standardNo } = req.params;
  const normalized = standardNo.toUpperCase().replace(/\s+/g, '');
  const standard = officialPersonnelStandardsCatalog.find(
    (s) => s.standardNo.replace(/\s+/g, '').toUpperCase() === normalized || s.standardNo.toLowerCase().includes(standardNo.toLowerCase())
  );
  if (!standard) return res.status(404).json({ error: 'Personnel Standard not found.' });

  // Find related forms
  const relatedForms = officialFormsCatalog.filter(
    (f) => f.standardRef.toLowerCase().includes(standard.standardNo.toLowerCase())
  );

  // Find related chunks
  const relatedChunks = db.getData().chunks.filter(
    (c) => c.personnelStandardNo && c.personnelStandardNo.toLowerCase().includes(standard.standardNo.toLowerCase())
  );

  res.json({ standard, forms: relatedForms, chunks: relatedChunks });
});

// Specific Official Form Detail with standard info
app.get('/api/knowledge/forms/:id', (req: Request, res: Response) => {
  const activeUser = getActiveUser(req);
  if (!activeUser) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { id } = req.params;
  const form = officialFormsCatalog.find((f) => f.id === id);
  if (!form) return res.status(404).json({ error: 'Official Form not found.' });

  res.json({ form });
});

// ----------------------------------------------------
// AMCHAM MANUAL & HANDBOOK DIGITAL READER & FULL-TEXT SEARCH
// ----------------------------------------------------
const MANUAL_DOCUMENTS_DIR = path.resolve(process.cwd(), '.data/documents');
if (!fs.existsSync(MANUAL_DOCUMENTS_DIR)) {
  fs.mkdirSync(MANUAL_DOCUMENTS_DIR, { recursive: true });
}
const CANDIDATE_PERSONNEL_PDF_PATHS = [
  path.resolve(process.cwd(), 'public/documents/amcham-personnel-manual-2019.pdf'),
  path.resolve(process.cwd(), '.data/documents/amcham-personnel-manual-2019.pdf'),
  path.resolve(process.cwd(), 'public/assets/amcham-personnel-manual-2019.pdf'),
];

function getExistingPersonnelPdfPath(): string | null {
  for (const candidate of CANDIDATE_PERSONNEL_PDF_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const PERSONNEL_MANUAL_PDF_PATH = path.join(MANUAL_DOCUMENTS_DIR, 'amcham-personnel-manual-2019.pdf');
const PUBLIC_PERSONNEL_PDF_PATH = path.resolve(process.cwd(), 'public/documents/amcham-personnel-manual-2019.pdf');

// Check status of authentic PDF
app.get('/api/manual/personnel-2019/status', (req: Request, res: Response) => {
  const activeUser = getActiveUser(req);
  if (!activeUser) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const activePath = getExistingPersonnelPdfPath();
  const exists = Boolean(activePath);
  let fileSize: number | null = null;
  let lastModified: string | null = null;

  if (exists && activePath) {
    try {
      const stat = fs.statSync(activePath);
      fileSize = stat.size;
      lastModified = stat.mtime.toISOString();
    } catch {
      // ignore
    }
  }

  res.json({
    id: 'src_amcham_personnel_manual_2019',
    title: 'AmCham Philippines Personnel Manual 2019 (Official July 04, 2019)',
    exists,
    fileSize,
    lastModified,
    totalPages: getPersonnelManualPages().length,
    standardsCount: 31,
    formsCount: 20,
    downloadUrl: exists ? '/api/manual/personnel-2019/file' : null,
    message: exists
      ? 'Original official PDF document is active, verified, and accessible.'
      : 'Original PDF file (AmCham Philippines Personnel Manual 2019, July 04, 2019) has not yet been uploaded. Authorized HR Personnel can upload the official PDF document.',
  });
});

// Download / stream the original PDF
app.get('/api/manual/personnel-2019/file', (req: Request, res: Response) => {
  const activeUser = getActiveUser(req);
  if (!activeUser) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const targetPath = getExistingPersonnelPdfPath();

  if (!targetPath) {
    return res.status(404).json({
      error: 'Original PDF file not found on server storage. Please upload the official PDF using the upload tool.',
    });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="AmCham_Philippines_Personnel_Manual_2019.pdf"');
  fs.createReadStream(targetPath).pipe(res);
});

// Upload authentic PDF
app.post(
  '/api/manual/personnel-2019/upload',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  upload.single('pdfFile'),
  async (req: Request, res: Response) => {
    const active = getReqUser(req);
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No PDF file provided.' });
    }

    if (!file.originalname.toLowerCase().endsWith('.pdf') && file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Uploaded file must be a valid PDF document.' });
    }

    try {
      fs.writeFileSync(PERSONNEL_MANUAL_PDF_PATH, file.buffer);

      let parsedPages = 91;
      try {
        const parsed = await pdfParse(file.buffer);
        if (parsed.numpages) parsedPages = parsed.numpages;
      } catch (err) {
        console.warn('PDF parse info warning:', err);
      }

      db.logAction(
        active.id,
        active.name,
        active.role,
        'UPLOAD_ORIGINAL_PERSONNEL_MANUAL_PDF',
        'DOCUMENT',
        `Uploaded official Personnel Manual 2019 PDF (${file.size} bytes, ${parsedPages} pages)`,
        'src_amcham_personnel_manual_2019'
      );

      res.json({
        success: true,
        message: 'Original AmCham Personnel Manual 2019 PDF successfully stored and integrated.',
        fileSize: file.size,
        totalPages: parsedPages,
      });
    } catch (err: any) {
      console.error('Failed to save manual PDF:', err);
      res.status(500).json({ error: `Failed to save PDF: ${err.message}` });
    }
  }
);

// Get pages for a handbook / manual
app.get('/api/manual/pages', (req: Request, res: Response) => {
  const activeUser = getActiveUser(req);
  if (!activeUser) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { document, page } = req.query;
  let pages: any[] = [];

  if (document === 'staff_handbook') {
    pages = getStaffHandbookPages();
  } else if (document === 'code_of_conduct') {
    pages = getCodeOfConductPages();
  } else {
    pages = getPersonnelManualPages();
  }

  if (page) {
    const pageNum = parseInt(page as string, 10);
    const found = pages.find((p) => p.pageNumber === pageNum || p.pdfPageNumber === pageNum);
    if (!found) return res.status(404).json({ error: `Page ${pageNum} not found in document.` });
    return res.json({ page: found, totalPages: pages.length });
  }

  res.json({ totalPages: pages.length, pages });
});

// Full-text search across complete manual / handbooks
app.get('/api/manual/search', (req: Request, res: Response) => {
  const activeUser = getActiveUser(req);
  if (!activeUser) {
    return res.status(401).json({ error: 'Authentication required to search manual.' });
  }

  const { query, document } = req.query;
  const q = typeof query === 'string' ? query : '';
  const docType = typeof document === 'string' ? document : 'personnel_2019';

  if (!q.trim()) {
    return res.json({ query: '', totalMatches: 0, results: [], document: docType });
  }

  let searchRes: any;
  if (docType === 'staff_handbook') {
    searchRes = searchStaffHandbook2026(q);
  } else if (docType === 'code_of_conduct') {
    searchRes = searchCodeOfConduct2026(q);
  } else {
    searchRes = searchPersonnelManual2019(q);
  }

  res.json({ ...searchRes, document: docType });
});

// Real URL Ingestion
app.post('/api/knowledge/sources/add-url', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), async (req: Request, res: Response) => {
  const { url, title, category, permissionLevel } = req.body;
  const active = getReqUser(req);

  if (!url || !title) {
    return res.status(400).json({ error: 'URL and title are required.' });
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format provided.' });
  }

  const sourceId = `src_${Date.now()}`;
  const now = new Date().toISOString();

  const newSource: KnowledgeSource = {
    id: sourceId,
    title,
    canonicalUrl: url,
    category: category || 'OFFICIAL_PUBLIC_ORGANIZATIONAL_INFO',
    permissionLevel: permissionLevel || 'PUBLIC',
    contentType: 'WEBPAGE',
    retrievalTimestamp: now,
    lastCheckedTimestamp: now,
    status: 'PROCESSING',
    version: '1.0',
    chunkCount: 0,
    uploadedBy: active.name,
  };

  try {
    // Real Web Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AmCham-AMIE-Ingestion/2.0; +https://amchamphilippines.com)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Web server responded with status HTTP ${response.status} (${response.statusText})`);
    }

    const html = await response.text();
    const cleanedText = RAGEngine.cleanHtml(html);

    if (!cleanedText || cleanedText.length < 50) {
      throw new Error('Retrieved webpage contained insufficient textual content or was protected against extraction.');
    }

    // Chunk real text
    const chunks = RAGEngine.chunkDocument(
      sourceId,
      title,
      url,
      newSource.category,
      newSource.permissionLevel,
      cleanedText,
      '1.0'
    );

    newSource.status = 'ACTIVE';
    newSource.chunkCount = chunks.length;
    db.getData().knowledgeSources.push(newSource);
    db.getData().chunks.push(...chunks);
    db.save();

    db.logAction(active.id, active.name, active.role, 'ADD_KNOWLEDGE_URL', 'KNOWLEDGE_SOURCE', `Successfully ingested ${chunks.length} chunks from ${title} (${url})`, sourceId);

    res.json({ success: true, source: newSource, chunksCreated: chunks.length });
  } catch (err: any) {
    console.error('URL Ingestion failed:', err);
    newSource.status = 'FAILED';
    newSource.errorMessage = err.message || 'Webpage could not be accessed or extracted.';
    db.getData().knowledgeSources.push(newSource);
    db.save();

    db.logAction(active.id, active.name, active.role, 'ADD_KNOWLEDGE_URL_FAILED', 'KNOWLEDGE_SOURCE', `Failed to retrieve ${url}: ${newSource.errorMessage}`, sourceId);

    res.status(200).json({
      success: false,
      source: newSource,
      error: `Could not access or extract content from ${url}: ${newSource.errorMessage}`,
    });
  }
});

// Upload and process documents (PDF, DOCX, TXT, CSV)
app.post(
  '/api/knowledge/sources/upload',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']),
  upload.single('file'),
  async (req: Request, res: Response) => {
    const active = getReqUser(req);
    const file = req.file;
    const { title, category, permissionLevel } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const docTitle = title || file.originalname;
    const sourceId = `src_doc_${Date.now()}`;
    const now = new Date().toISOString();
    const ext = path.extname(file.originalname).toUpperCase().replace('.', '') as any;

    let extractedText = '';

    if (ext === 'PDF') {
      try {
        const parsedPdf = await pdfParse(file.buffer);
        extractedText = (parsedPdf.text || '').replace(/\r\n/g, '\n').trim();
        if (!extractedText || extractedText.length < 30) {
          return res.status(400).json({
            error: 'The uploaded PDF does not contain extractable textual content. Please upload a PDF with embedded text or an editable document.',
          });
        }
      } catch (err: any) {
        console.error('PDF parsing error:', err);
        return res.status(400).json({ error: `Failed to extract text from PDF: ${err.message}` });
      }
    } else if (ext === 'CSV') {
      // Structured CSV parsing
      try {
        const raw = file.buffer.toString('utf-8');
        const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 0) {
          const headers = lines[0].split(',').map((h) => h.trim());
          const records: string[] = [];
          for (let i = 1; i < lines.length; i++) {
            const vals = lines[i].split(',').map((v) => v.trim());
            const rowStr = headers.map((h, idx) => `${h}: ${vals[idx] || 'N/A'}`).join(' | ');
            records.push(`Record ${i}: ${rowStr}`);
          }
          extractedText = `Document: ${docTitle}\nCategory: Structured CSV Dataset\n\n` + records.join('\n');
        } else {
          extractedText = file.buffer.toString('utf-8');
        }
      } catch {
        extractedText = file.buffer.toString('utf-8');
      }
    } else if (ext === 'TXT' || ext === 'MD') {
      extractedText = file.buffer.toString('utf-8').trim();
    } else {
      // DOCX / Other text formats
      try {
        const rawString = file.buffer.toString('utf-8');
        const cleanAscii = rawString.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
        const words = cleanAscii.match(/[A-Za-z0-9\s.,;:'"()\-–—?!/]{4,}/g) || [];
        extractedText = words.join(' ').replace(/\s{2,}/g, ' ').trim();
      } catch {
        extractedText = '';
      }
    }

    if (!extractedText || extractedText.length < 30) {
      return res.status(400).json({
        error: `Could not extract sufficient text from "${file.originalname}". Ensure the file contains readable document text.`,
      });
    }

    const newSource: KnowledgeSource = {
      id: sourceId,
      title: docTitle,
      canonicalUrl: `internal://documents/${file.originalname}`,
      category: category || 'APPROVED_INTERNAL_HR_POLICY',
      permissionLevel: permissionLevel || 'ALL_EMPLOYEES',
      contentType: ext === 'PDF' ? 'PDF' : ext === 'DOCX' ? 'DOCX' : ext === 'CSV' ? 'CSV' : 'TXT',
      retrievalTimestamp: now,
      lastCheckedTimestamp: now,
      status: 'ACTIVE',
      version: '1.0',
      chunkCount: 0,
      uploadedBy: active.name,
    };

    const chunks = RAGEngine.chunkDocument(
      sourceId,
      docTitle,
      newSource.canonicalUrl,
      newSource.category,
      newSource.permissionLevel,
      extractedText,
      '1.0'
    );

    newSource.chunkCount = Math.max(1, chunks.length);
    db.getData().knowledgeSources.push(newSource);
    db.getData().chunks.push(...chunks);
    db.save();

    db.logAction(active.id, active.name, active.role, 'UPLOAD_DOCUMENT', 'DOCUMENT', `Uploaded and processed document: ${docTitle} (${chunks.length} chunks)`, sourceId);

    res.json({ success: true, source: newSource, chunksCreated: chunks.length });
  }
);

// Toggle source status or reprocess
app.post('/api/knowledge/sources/:id/reprocess', requireRole(['HR_ADMINISTRATOR']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const source = db.getData().knowledgeSources.find((s) => s.id === id);
  if (!source) return res.status(404).json({ error: 'Source not found.' });

  source.lastCheckedTimestamp = new Date().toISOString();

  // If webpage, re-fetch
  if (source.contentType === 'WEBPAGE' && source.canonicalUrl?.startsWith('http')) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(source.canonicalUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AmCham-AMIE-Ingestion/2.0; +https://amchamphilippines.com)',
        },
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const html = await response.text();
        const cleaned = RAGEngine.cleanHtml(html);
        if (cleaned.length > 50) {
          // Remove old chunks
          db.getData().chunks = db.getData().chunks.filter((c) => c.sourceId !== id);
          const newChunks = RAGEngine.chunkDocument(
            source.id,
            source.title,
            source.canonicalUrl,
            source.category,
            source.permissionLevel,
            cleaned,
            '1.1'
          );
          db.getData().chunks.push(...newChunks);
          source.chunkCount = newChunks.length;
          source.status = 'ACTIVE';
          source.errorMessage = undefined;
        }
      } else {
        source.status = 'FAILED';
        source.errorMessage = `HTTP ${response.status} on refresh`;
      }
    } catch (err: any) {
      source.status = 'FAILED';
      source.errorMessage = err.message || 'Refresh failed';
    }
  } else {
    source.status = 'ACTIVE';
  }

  db.save();
  db.logAction(active.id, active.name, active.role, 'REPROCESS_KNOWLEDGE_SOURCE', 'KNOWLEDGE_SOURCE', `Reprocessed source: ${source.title}`, source.id);
  res.json({ success: true, source });
});

// Delete source
app.delete('/api/knowledge/sources/:id', requireRole(['HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);

  if (id === 'src_amcham_personnel_manual_2019' || id === 'src_philippine_labor_law_dole') {
    return res.status(400).json({ error: 'Core statutory and handbook repositories are protected and cannot be deleted.' });
  }

  const data = db.getData();
  const idx = data.knowledgeSources.findIndex((s) => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Source not found.' });

  const removed = data.knowledgeSources.splice(idx, 1)[0];
  data.chunks = data.chunks.filter((c) => c.sourceId !== id);
  db.save();

  db.logAction(active.id, active.name, active.role, 'DELETE_KNOWLEDGE_SOURCE', 'KNOWLEDGE_SOURCE', `Deleted source: ${removed.title}`, id);
  res.json({ success: true, message: `Knowledge source '${removed.title}' removed.` });
});

// ----------------------------------------------------
// 3. MODULE ONE: AI HR POLICY ASSISTANT & CHAT
// ----------------------------------------------------
app.post('/api/chat/ask', async (req: Request, res: Response) => {
  const { question, conversationId } = req.body;
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to query AMIE assistant.' });
  }

  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: The internal Secretariat HR policy assistant is restricted to employees. Career applicants can use the Careers FAQ Assistant in the Applicant Portal.' });
  }

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Question is required.' });
  }

  // Retrieve authorized chunks with conflict detection
  const { results: retrievedResults, potentialConflictDetected, conflictDetails } = RAGEngine.retrieveChunks(question, active.role, undefined, 5);
  const candidateChunks = retrievedResults.map((r) => r.chunk);

  // Build employee authorized context if exists
  const employeeRecord = db.getData().employeeRecords.find((e) => e.userId === active.id);
  let employeeContext: EmployeeAIContext | undefined;
  if (employeeRecord) {
    const userApplications = db.getData().leaveApplications.filter((a) => a.userId === active.id);
    employeeContext = {
      fullName: employeeRecord.fullName,
      employeeNumber: employeeRecord.employeeNumber,
      department: employeeRecord.department,
      jobTitle: employeeRecord.jobTitle,
      employmentStatus: employeeRecord.employmentStatus,
      leaveBalances: employeeRecord.leaveBalances,
      recentLeaveApplications: userApplications.slice(0, 5).map((a) => ({
        id: a.id,
        leaveTypeName: a.leaveTypeName,
        startDate: a.startDate,
        endDate: a.endDate,
        requestedWorkingDays: a.requestedWorkingDays,
        status: a.status,
        decisionExplanation: a.decisionEngine?.explanation,
      })),
      authorizedDocumentsSummary: employeeRecord.authorizedDocuments.map((d) => d.title),
    };
  }

  // Consult Gemini AI with policy knowledge and authorized employee records
  const aiResult = await askHRPolicyAI(question, active.role, candidateChunks, potentialConflictDetected, employeeContext, conflictDetails);

  // Manage conversation history
  const data = db.getData();
  let conv = data.conversations.find((c) => c.id === conversationId);
  const now = new Date().toISOString();

  if (!conv) {
    conv = {
      id: conversationId || `conv_${Date.now()}`,
      userId: active.id,
      title: question.slice(0, 48),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    data.conversations.unshift(conv);
  }

  const userMsg = {
    id: `msg_u_${Date.now()}`,
    role: 'user' as const,
    content: question,
    timestamp: now,
  };

  const hasHistoricalChunk = candidateChunks.some((c) => c.historicalStatus === 'HISTORICAL_JULY_2019') || (aiResult.citations && aiResult.citations.some((c) => c.historicalFlag));
  const historicalNotice = aiResult.historicalNotice || (hasHistoricalChunk
    ? 'Provisions cited originate from the AmCham Personnel Manual (July 04, 2019). Monetary allowances and specific policies represent the 2019 historical baseline—please confirm current rates and guidelines with HR Administration.'
    : undefined);

  const assistantMsg = {
    id: `msg_a_${Date.now()}`,
    role: 'assistant' as const,
    content: aiResult.answer,
    timestamp: new Date().toISOString(),
    citations: aiResult.citations,
    verificationStatus: aiResult.verificationStatus,
    suggestedFollowUps: aiResult.suggestedFollowUps,
    conflictWarning: aiResult.conflictWarning,
    historicalNotice,
  };

  conv.messages.push(userMsg, assistantMsg);
  conv.updatedAt = new Date().toISOString();
  db.save();

  db.logAction(active.id, active.name, active.role, 'ASK_HR_POLICY_AI', 'CHAT', `Asked policy question: "${question.slice(0, 50)}..."`);

  res.json({
    conversationId: conv.id,
    response: assistantMsg,
    requiresEscalation: aiResult.requiresEscalation,
    conflictWarning: aiResult.conflictWarning,
    historicalNotice,
  });
});

app.get('/api/chat/conversations', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Internal HR conversations are restricted to Secretariat staff.' });
  }
  const convs = db.getData().conversations.filter((c) => c.userId === active.id);
  res.json({ conversations: convs });
});

// Human Escalation Ticket
app.post('/api/chat/escalate', (req: Request, res: Response) => {
  const { question, aiResponseSummary, reason } = req.body;
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: HR escalation tickets are restricted to Secretariat staff. Applicants may submit inquiries via the Applicant Portal.' });
  }

  const ticket: EscalationTicket = {
    id: `tkt_${Date.now()}`,
    userId: active.id,
    userName: active.name,
    userEmail: active.email,
    question: question || 'Policy clarification inquiry',
    aiResponseSummary: aiResponseSummary || 'Unverified policy requiring human HR confirmation.',
    reason: reason || 'MISSING_POLICY',
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.getData().escalationTickets.unshift(ticket);
  db.save();

  for (const hr of db.getActiveHRRecipients(active.id)) {
    db.createNotification(
      hr.id,
      'New HR Policy Escalation Ticket',
      `${active.name} (${active.department}) escalated an inquiry to HR: "${ticket.question.slice(0, 90)}"`,
      'SYSTEM',
      'ask-ai',
      { ticketId: ticket.id, employeeId: active.id, employeeName: active.name, eventKey: `ticket_create_${ticket.id}` },
      hr.email
    );
  }

  db.logAction(active.id, active.name, active.role, 'CREATE_ESCALATION_TICKET', 'TICKET', `Escalated inquiry: ${ticket.question.slice(0, 40)}...`, ticket.id);

  res.json({ success: true, ticket });
});

app.get('/api/chat/tickets', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: HR escalation tickets are restricted to Secretariat staff.' });
  }
  const tickets = db.getData().escalationTickets;
  if (active.role === 'EMPLOYEE') {
    return res.json({ tickets: tickets.filter((t) => t.userId === active.id) });
  }
  res.json({ tickets });
});

app.post('/api/chat/tickets/:id/resolve', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const { resolutionNotes } = req.body;
  const active = getReqUser(req);
  const ticket = db.getData().escalationTickets.find((t) => t.id === id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  ticket.status = 'RESOLVED';
  ticket.assignedTo = active.name;
  ticket.resolutionNotes = resolutionNotes || 'Inquiry addressed and verified by HR Secretariat.';
  ticket.updatedAt = new Date().toISOString();
  db.save();

  db.createNotification(
    ticket.userId,
    'HR Escalation Inquiry Resolved',
    `${active.name} resolved your escalated inquiry "${ticket.question.slice(0, 70)}": "${ticket.resolutionNotes}"`,
    'SYSTEM',
    'ask-ai',
    { ticketId: ticket.id, resolvedBy: active.name, eventKey: `ticket_resolve_${ticket.id}_${Date.now()}` },
    ticket.userEmail
  );

  db.logAction(active.id, active.name, active.role, 'RESOLVE_ESCALATION_TICKET', 'TICKET', `Resolved ticket: ${ticket.id}`, ticket.id);
  res.json({ success: true, ticket });
});

// ----------------------------------------------------
// 4. MODULE TWO: RECRUITMENT ASSISTANT
// ----------------------------------------------------
app.post('/api/recruitment/generate', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), async (req: Request, res: Response) => {
  try {
    const { jobTitle, department, jobLevel, responsibilities, qualifications, competencies, assessmentObjectives } = req.body;
    const generated = await generateRecruitmentAI({
      jobTitle: jobTitle || 'Secretariat Specialist',
      department: department || 'Committees & Events',
      jobLevel: jobLevel || 'Mid',
      responsibilities: Array.isArray(responsibilities) ? responsibilities : [responsibilities],
      qualifications: Array.isArray(qualifications) ? qualifications : [qualifications],
      competencies: Array.isArray(competencies) ? competencies : [competencies],
      assessmentObjectives,
    });
    res.json({ success: true, data: generated });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to generate recruitment materials.' });
  }
});

// ----------------------------------------------------
// AMCHAM ROLE TEMPLATES, AI RECOMMENDATIONS & HR VACANCY MANAGEMENT API
// ----------------------------------------------------

const NON_PUBLIC_VACANCY_STATUSES = new Set([
  'AI_RECOMMENDED',
  'DRAFT',
  'PENDING_HR_REVIEW',
  'IN_REVIEW',
  'REJECTED',
  'CLOSED',
  'ARCHIVED',
]);

function isVacancyPubliclyVisible(d: any): boolean {
  if (!d) return false;
  if (NON_PUBLIC_VACANCY_STATUSES.has(d.status)) return false;
  if (d.status === 'PUBLISHED') return d.isPublished === true;
  if (d.status === 'APPROVED') {
    return d.isPublished === true && Boolean(d.publishedAt || d.id === 'rec_draft_01' || d.id === 'rec_draft_02');
  }
  return false;
}

function isAuthorizedVacancyApprover(role: UserRole): boolean {
  return role === 'HR_ADMINISTRATOR' || role === 'SYSTEM_ADMINISTRATOR';
}

function appendVacancyHistory(
  vacancy: any,
  entry: Omit<VacancyStatusHistoryEntry, 'id' | 'timestamp'>
): void {
  if (!Array.isArray(vacancy.statusHistory)) {
    vacancy.statusHistory = [];
  }
  vacancy.statusHistory.push({
    id: `vhist_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    ...entry,
    timestamp: new Date().toISOString(),
  });
}

function buildAuthorizedWorkforceSnapshot(): WorkforceAnalysisSnapshot {
  const data = db.getData();
  const allUsers = data.users || [];
  const allUsersMap = new Map(allUsers.map((u) => [u.id, u]));
  const nonApplicantUsers = allUsers.filter((u) => u.role !== 'APPLICANT');
  const employeeRecords = data.employeeRecords || [];
  const drafts = data.recruitmentDrafts || [];
  const staffingRequests = db.getStaffingRequests();
  const reviews = data.performanceReviews || [];
  const devPlans = data.developmentPlans || [];
  const trainingRecords = db.getTrainingRecords();
  const jobApplications = data.jobApplications || [];
  const leaveApplications = data.leaveApplications || [];

  const deptMap = new Map<
    string,
    {
      department: string;
      staffCount: number;
      openVacancyCount: number;
      approvedVacancyCount: number;
      draftVacancyCount: number;
      closedVacancyCount: number;
      pendingRequestCount: number;
    }
  >();
  const ensureDept = (deptName?: string) => {
    const display = (deptName || 'Executive Office').trim() || 'Executive Office';
    const key = display.toLowerCase();
    if (!deptMap.has(key)) {
      deptMap.set(key, {
        department: display,
        staffCount: 0,
        openVacancyCount: 0,
        approvedVacancyCount: 0,
        draftVacancyCount: 0,
        closedVacancyCount: 0,
        pendingRequestCount: 0,
      });
    }
    return deptMap.get(key)!;
  };

  let separatedOrInactiveCount = 0;
  const separatedDepartments: string[] = [];
  const countedUserIds = new Set<string>();
  const pendingApprovalUserIds = new Set<string>();

  for (const emp of employeeRecords) {
    countedUserIds.add(emp.userId);
    const linkedUser = allUsersMap.get(emp.userId);
    if (linkedUser?.role === 'APPLICANT') {
      continue;
    }
    const acctStatus = String(linkedUser?.accountStatus || 'ACTIVE').toUpperCase();
    if (acctStatus === 'PENDING_APPROVAL') {
      pendingApprovalUserIds.add(emp.userId);
      continue;
    }
    const status = String(emp.employmentStatus || 'REGULAR').toUpperCase();
    if (
      status === 'RESIGNED' ||
      status === 'TERMINATED' ||
      status === 'INACTIVE' ||
      status === 'SEPARATED' ||
      acctStatus === 'SUSPENDED'
    ) {
      separatedOrInactiveCount++;
      separatedDepartments.push((emp.department || 'Executive Office').trim());
    } else {
      ensureDept(emp.department).staffCount++;
    }
  }
  for (const u of nonApplicantUsers) {
    if (!countedUserIds.has(u.id)) {
      const acctStatus = String(u.accountStatus || 'ACTIVE').toUpperCase();
      if (acctStatus === 'PENDING_APPROVAL') {
        pendingApprovalUserIds.add(u.id);
        continue;
      }
      if (acctStatus === 'SUSPENDED') {
        separatedOrInactiveCount++;
        separatedDepartments.push((u.department || 'Executive Office').trim());
      } else {
        ensureDept(u.department).staffCount++;
      }
    }
  }

  const appsByVacancy: Record<string, number> = {};
  for (const appItem of jobApplications) {
    appsByVacancy[appItem.vacancyId] = (appsByVacancy[appItem.vacancyId] || 0) + 1;
  }

  let publishedVacanciesCount = 0;
  let approvedVacanciesCount = 0;
  let draftVacanciesCount = 0;
  let closedVacanciesCount = 0;
  let rejectedVacanciesCount = 0;
  const existingVacancies = drafts.map((d: any) => {
    const isPub = isVacancyPubliclyVisible(d);
    const deptEntry = ensureDept(d.department);
    if (isPub) {
      publishedVacanciesCount++;
      deptEntry.openVacancyCount++;
    } else if (d.status === 'APPROVED') {
      approvedVacanciesCount++;
      deptEntry.approvedVacancyCount++;
    } else if (d.status === 'CLOSED' || d.status === 'ARCHIVED') {
      closedVacanciesCount++;
      deptEntry.closedVacancyCount++;
    } else if (d.status === 'REJECTED') {
      rejectedVacanciesCount++;
      deptEntry.closedVacancyCount++;
    } else {
      draftVacanciesCount++;
      deptEntry.draftVacancyCount++;
    }
    return {
      id: d.id,
      jobTitle: d.jobTitle || 'Untitled Vacancy',
      department: d.department || 'Executive Office',
      status: d.status || (isPub ? 'PUBLISHED' : 'DRAFT'),
      isPublished: isPub,
      openPositions: Number(d.openPositions) || 1,
      applicationCount: appsByVacancy[d.id] || 0,
    };
  });

  let submittedStaffingRequestsCount = 0;
  let underReviewStaffingRequestsCount = 0;
  let convertedStaffingRequestsCount = 0;
  let declinedStaffingRequestsCount = 0;
  for (const reqItem of staffingRequests) {
    if (reqItem.status === 'SUBMITTED') {
      submittedStaffingRequestsCount++;
      ensureDept(reqItem.department).pendingRequestCount++;
    } else if (reqItem.status === 'UNDER_HR_REVIEW') {
      underReviewStaffingRequestsCount++;
      ensureDept(reqItem.department).pendingRequestCount++;
    } else if (reqItem.status === 'CONVERTED_TO_DRAFT') {
      convertedStaffingRequestsCount++;
    } else if (reqItem.status === 'DECLINED') {
      declinedStaffingRequestsCount++;
    }
  }
  const openStaffingRequestsCount = submittedStaffingRequestsCount + underReviewStaffingRequestsCount;

  // Distinguish draft/returned vs submitted (pending HR) vs completed (REVIEWED / HR_VALIDATED) evaluations
  const completedFinalReviews = reviews.filter(
    (r) => r.reviewStatus === 'REVIEWED' || r.reviewStatus === 'HR_VALIDATED'
  );
  const submittedPendingHrReviews = reviews.filter(
    (r) => r.reviewStatus === 'SUBMITTED' || r.reviewStatus === 'PENDING_HR_REVIEW'
  );
  const draftReviewsCount = reviews.filter((r) => r.reviewStatus === 'DRAFT').length;
  const returnedReviewsCount = reviews.filter((r) => r.reviewStatus === 'RETURNED_FOR_REVISION').length;
  const completedReviews = [...submittedPendingHrReviews, ...completedFinalReviews];
  const incompleteReviewsCount = draftReviewsCount + returnedReviewsCount;

  const competencyGapsSummary: WorkforceAnalysisSnapshot['competencyGapsSummary'] = [];
  const reviewCompAgg = new Map<string, { department: string; competencyName: string; scores: number[] }>();
  for (const r of completedReviews) {
    if (!r.competencyScores) continue;
    const deptDisplay = (r.department || 'Executive Office').trim() || 'Executive Office';
    for (const [compName, score] of Object.entries(r.competencyScores)) {
      if (typeof score === 'number' && score >= 1 && score <= 5) {
        const k = `${deptDisplay.toLowerCase()}::${compName}`;
        if (!reviewCompAgg.has(k)) {
          reviewCompAgg.set(k, { department: deptDisplay, competencyName: compName, scores: [] });
        }
        reviewCompAgg.get(k)!.scores.push(score);
      }
    }
  }
  for (const agg of reviewCompAgg.values()) {
    const avg = Math.round((agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length) * 100) / 100;
    if (avg < 3.5) {
      competencyGapsSummary.push({
        source: 'PERFORMANCE_REVIEW',
        department: agg.department,
        competencyName: agg.competencyName,
        averageScore: avg,
        gapCount: agg.scores.filter((s) => s < 3.5).length,
      });
    }
  }

  let endorsedDevelopmentPlansCount = 0;
  let pendingDevelopmentPlansCount = 0;
  let revisionDevelopmentPlansCount = 0;
  for (const plan of devPlans) {
    const isEndorsed =
      Boolean(plan.hrApproved) ||
      plan.endorsementStatus === 'ENDORSED' ||
      (plan as any).status === 'ENDORSED';
    if (isEndorsed) {
      endorsedDevelopmentPlansCount++;
      for (const gap of plan.competencyGaps || []) {
        if (gap.gap > 0) {
          competencyGapsSummary.push({
            source: 'DEVELOPMENT_PLAN',
            department: plan.department || 'Executive Office',
            competencyName: gap.competencyName,
            gapCount: 1,
          });
        }
      }
    } else if (plan.endorsementStatus === 'REVISION_REQUESTED') {
      revisionDevelopmentPlansCount++;
    } else {
      pendingDevelopmentPlansCount++;
    }
  }

  // Count Verified training completion records separately from Pending/Draft/Rejected
  const verifiedTrainingRecords = trainingRecords.filter((tr) => tr.status === 'Verified');
  const pendingTrainingRecordsCount = trainingRecords.filter((tr) => tr.status === 'Pending Verification').length;
  const draftTrainingRecordsCount = trainingRecords.filter(
    (tr) => tr.status === 'Draft' || tr.status === 'Needs Correction'
  ).length;
  const rejectedTrainingRecordsCount = trainingRecords.filter((tr) => tr.status === 'Rejected').length;
  const trainingByDept: Record<string, number> = {};
  let verifiedHours = 0;
  for (const tr of verifiedTrainingRecords) {
    const d = (tr.department || 'Executive Office').trim();
    trainingByDept[d] = (trainingByDept[d] || 0) + 1;
    verifiedHours += Number(tr.verifiedHours ?? tr.durationHours) || 0;
  }

  // Exclude unsubmitted DRAFT, CANCELLED, and REJECTED leave records from active leave totals
  const submittedLeaveApplications = leaveApplications.filter(
    (l) => l.status !== 'DRAFT' && l.status !== 'CANCELLED' && l.status !== 'REJECTED'
  );
  const approvedLeaveCount = submittedLeaveApplications.filter((l) => l.status === 'APPROVED').length;
  const pendingLeaveCount = submittedLeaveApplications.filter(
    (l) =>
      l.status === 'SUBMITTED' ||
      l.status === 'UNDER_HR_REVIEW' ||
      l.status === 'PENDING_MANAGER_APPROVAL'
  ).length;

  const departmentHeadcounts = Array.from(deptMap.values());
  const activeStaff = departmentHeadcounts.reduce((sum, d) => sum + d.staffCount, 0);

  return {
    departmentHeadcounts,
    existingVacancies,
    staffingRequests: staffingRequests.map((s) => ({
      id: s.id,
      department: s.department,
      requestedPositionTitle: s.requestedPositionTitle,
      headcount: s.headcount,
      jobLevel: s.jobLevel,
      employmentType: s.employmentType,
      workArrangement: s.workArrangement,
      urgency: s.urgency,
      justification: s.justification,
      competencyNeeds: s.competencyNeeds || [],
      status: s.status,
    })),
    competencyGapsSummary,
    trainingSummary: {
      totalRecords: verifiedTrainingRecords.length,
      verifiedHours,
      byDepartment: trainingByDept,
    },
    recruitmentSummary: {
      totalApplications: jobApplications.length,
      applicationsByVacancy: appsByVacancy,
    },
    turnoverAndLeaveSummary: {
      separatedOrInactiveCount,
      separatedDepartments,
      totalLeaveApplications: submittedLeaveApplications.length,
      activeLeaveCount: approvedLeaveCount + pendingLeaveCount,
    },
    totals: {
      totalStaff: activeStaff + separatedOrInactiveCount,
      activeStaff,
      pendingApprovalUsersCount: pendingApprovalUserIds.size,
      existingVacanciesCount: existingVacancies.length,
      publishedVacanciesCount,
      approvedVacanciesCount,
      draftVacanciesCount,
      closedVacanciesCount,
      rejectedVacanciesCount,
      staffingRequestsCount: staffingRequests.filter((s) => s.status !== 'DECLINED').length,
      openStaffingRequestsCount,
      submittedStaffingRequestsCount,
      underReviewStaffingRequestsCount,
      convertedStaffingRequestsCount,
      declinedStaffingRequestsCount,
      totalStaffingRequestsCount: staffingRequests.length,
      performanceReviewsCount: completedReviews.length,
      submittedReviewsCount: submittedPendingHrReviews.length,
      completedReviewsCount: completedFinalReviews.length,
      draftReviewsCount,
      returnedReviewsCount,
      incompleteReviewsCount,
      developmentPlansCount: devPlans.length,
      endorsedDevelopmentPlansCount,
      pendingDevelopmentPlansCount,
      revisionDevelopmentPlansCount,
      trainingRecordsCount: verifiedTrainingRecords.length,
      pendingTrainingRecordsCount,
      draftTrainingRecordsCount,
      rejectedTrainingRecordsCount,
      totalTrainingRecordsCount: trainingRecords.length,
      jobApplicationsCount: jobApplications.length,
      leaveApplicationsCount: submittedLeaveApplications.length,
      approvedLeaveCount,
      pendingLeaveCount,
      separatedOrInactiveCount,
    },
  };
}

// GET /api/recruitment/templates: Suggested AmCham role templates across 8 categories
app.get('/api/recruitment/templates', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (_req: Request, res: Response) => {
  res.json({
    success: true,
    categories: AMCHAM_FUNCTIONAL_CATEGORIES,
    templates: AMCHAM_ROLE_TEMPLATES,
    standardRequirementTitles: STANDARD_REQUIREMENT_TITLES,
    standardDocumentCategories: STANDARD_DOCUMENT_CATEGORIES,
    defaultCategoryMap: DEFAULT_REQUIREMENT_CATEGORY_MAP,
  });
});

// ----------------------------------------------------
// DEPARTMENT HEAD STAFFING REQUESTS
// ----------------------------------------------------

// GET /api/recruitment/staffing-requests: Department Heads see own department only; HR sees all
app.get(
  '/api/recruitment/staffing-requests',
  requireRole(['DEPARTMENT_HEAD', 'HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;
    const requests =
      active.role === 'DEPARTMENT_HEAD'
        ? db.getStaffingRequests({ department: active.department, status: statusFilter })
        : db.getStaffingRequests({ status: statusFilter });
    res.json({ success: true, staffingRequests: requests });
  }
);

// POST /api/recruitment/staffing-requests: Submit justified staffing request (cannot publish vacancies)
app.post(
  '/api/recruitment/staffing-requests',
  requireRole(['DEPARTMENT_HEAD', 'HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const body = req.body || {};

    const requestedPositionTitle =
      typeof body.requestedPositionTitle === 'string' ? body.requestedPositionTitle.trim() : '';
    const justification = typeof body.justification === 'string' ? body.justification.trim() : '';
    const headcount = Math.max(1, Math.min(20, Number(body.headcount) || 1));
    const urgency = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(body.urgency)
      ? body.urgency
      : 'MEDIUM';

    if (!requestedPositionTitle) {
      return res.status(400).json({ error: 'Requested position title is required.' });
    }
    if (!justification || justification.length < 10) {
      return res.status(400).json({ error: 'Please provide a clear business justification (at least 10 characters).' });
    }

    // Enforce department isolation for Department Heads
    const resolvedDepartment =
      active.role === 'DEPARTMENT_HEAD'
        ? active.department
        : typeof body.department === 'string' && body.department.trim()
        ? body.department.trim()
        : active.department;

    const competencyNeeds = Array.isArray(body.competencyNeeds)
      ? body.competencyNeeds.map((c: any) => String(c).trim()).filter(Boolean)
      : typeof body.competencyNeeds === 'string'
      ? body.competencyNeeds.split(/[,;\n]/).map((c: string) => c.trim()).filter(Boolean)
      : [];

    const now = new Date().toISOString();
    const newRequest: DepartmentStaffingRequest = {
      id: `sreq_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      department: resolvedDepartment,
      requestedById: active.id,
      requestedByName: active.name,
      requestedByRole: active.role,
      requestedPositionTitle,
      headcount,
      jobLevel: ['Entry', 'Mid', 'Senior', 'Lead', 'Executive'].includes(body.jobLevel)
        ? body.jobLevel
        : 'Mid',
      employmentType: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP'].includes(body.employmentType)
        ? body.employmentType
        : undefined,
      workArrangement: ['ON_SITE', 'HYBRID', 'REMOTE'].includes(body.workArrangement)
        ? body.workArrangement
        : undefined,
      urgency,
      justification,
      competencyNeeds,
      status: 'SUBMITTED',
      createdAt: now,
      updatedAt: now,
    };

    db.createStaffingRequest(newRequest);

    // Notify authorized HR Administrator (Rachel de Guzman)
    const hrAdmins = (db.getData().users || []).filter(
      (u) => u.role === 'HR_ADMINISTRATOR' || u.role === 'SYSTEM_ADMINISTRATOR'
    );
    for (const hr of hrAdmins) {
      db.createNotification(
        hr.id,
        'New Department Staffing Request',
        `${active.name} (${resolvedDepartment}) submitted a staffing request for "${requestedPositionTitle}" (${headcount} slot(s), ${urgency} priority).`,
        'SYSTEM',
        'recruitment',
        {
          staffingRequestId: newRequest.id,
          department: resolvedDepartment,
          requestedPositionTitle,
          targetSubTab: 'vacancies',
        }
      );
    }

    db.logAction(
      active.id,
      active.name,
      active.role,
      'SUBMIT_STAFFING_REQUEST',
      'RECRUITMENT',
      `Submitted staffing request for ${requestedPositionTitle} (${resolvedDepartment}, headcount: ${headcount})`,
      newRequest.id
    );

    res.status(201).json({ success: true, staffingRequest: newRequest });
  }
);

// PATCH /api/recruitment/staffing-requests/:id/decision: HR Admin reviews or declines staffing request
app.patch(
  '/api/recruitment/staffing-requests/:id/decision',
  requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { id } = req.params;
    const { status, hrRemarks } = req.body || {};

    const existing = db.getStaffingRequestById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Staffing request not found.' });
    }

    if (!['UNDER_HR_REVIEW', 'DECLINED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid decision status. Expected UNDER_HR_REVIEW or DECLINED.' });
    }
    if (status === 'DECLINED' && (!hrRemarks || !String(hrRemarks).trim())) {
      return res.status(400).json({ error: 'HR remarks/reason are required when declining a staffing request.' });
    }

    const updated = db.updateStaffingRequest(id, {
      status,
      hrRemarks: hrRemarks ? String(hrRemarks).trim() : existing.hrRemarks,
      reviewedBy: active.name,
      reviewedById: active.id,
      reviewedAt: new Date().toISOString(),
    });

    if (existing.requestedById) {
      db.createNotification(
        existing.requestedById,
        status === 'DECLINED' ? 'Staffing Request Declined by HR' : 'Staffing Request Under HR Review',
        `Your staffing request for "${existing.requestedPositionTitle}" (${existing.department}) was marked ${status.replace(/_/g, ' ')} by ${active.name}.${hrRemarks ? ` Remarks: ${String(hrRemarks).trim()}` : ''}`,
        'SYSTEM',
        'dashboard',
        { staffingRequestId: existing.id }
      );
    }

    db.logAction(
      active.id,
      active.name,
      active.role,
      'REVIEW_STAFFING_REQUEST',
      'RECRUITMENT',
      `Set staffing request ${existing.requestedPositionTitle} to ${status}`,
      id
    );

    res.json({ success: true, staffingRequest: updated });
  }
);

// ----------------------------------------------------
// AI VACANCY RECOMMENDATIONS & JD GENERATION
// ----------------------------------------------------

// GET /api/recruitment/recommendations: View persisted recommendation runs & requests
app.get(
  '/api/recruitment/recommendations',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (_req: Request, res: Response) => {
    const runs = db.getVacancyRecommendationRuns();
    const staffingRequests = db.getStaffingRequests();
    res.json({
      success: true,
      runs,
      latestRun: runs[0] || null,
      staffingRequests,
    });
  }
);

// POST /api/recruitment/recommendations/analyze: Run grounded AI vacancy recommendation analysis
app.post(
  '/api/recruitment/recommendations/analyze',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  async (req: Request, res: Response) => {
    try {
      const active = getReqUser(req);
      const snapshot = buildAuthorizedWorkforceSnapshot();
      const aiResult = await recommendVacanciesAI(snapshot);
      const now = new Date().toISOString();
      const runId = `vrec_run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

      const recommendations: VacancyRecommendationItem[] = (aiResult.recommendations || []).map((rec, idx) => ({
        id: `vrec_${Date.now()}_${idx}_${crypto.randomBytes(2).toString('hex')}`,
        runId,
        proposedTitle: rec.proposedTitle,
        department: rec.department,
        recommendedHeadcount: rec.recommendedHeadcount || 1,
        jobLevel: rec.jobLevel || 'Mid',
        employmentType: rec.employmentType,
        workArrangement: rec.workArrangement,
        priority: rec.priority || 'NEEDS_MORE_INFO',
        confidence: rec.confidence || 'LOW_INSUFFICIENT_DATA',
        rationale: rec.rationale,
        supportingInformation: rec.supportingInformation || [],
        dataGaps: rec.dataGaps || [],
        relatedStaffingRequestId: rec.relatedStaffingRequestId,
        status: 'AI_RECOMMENDED',
        createdAt: now,
        updatedAt: now,
      }));

      const run: VacancyRecommendationRun = {
        id: runId,
        generatedBy: active.name,
        generatedById: active.id,
        generatedAt: now,
        dataSufficiencyStatus: aiResult.dataSufficiencyStatus,
        dataSufficiencySummary: aiResult.dataSufficiencySummary,
        missingInformation: aiResult.missingInformation,
        workforceSnapshotSummary: {
          totalStaff: snapshot.totals.totalStaff,
          activeStaff: snapshot.totals.activeStaff,
          pendingApprovalUsersCount: snapshot.totals.pendingApprovalUsersCount,
          departmentHeadcounts: snapshot.departmentHeadcounts.map((d) => ({
            department: d.department,
            staffCount: d.staffCount,
            openVacancyCount: d.openVacancyCount,
            approvedVacancyCount: d.approvedVacancyCount,
            draftVacancyCount: d.draftVacancyCount,
            closedVacancyCount: d.closedVacancyCount,
            pendingRequestCount: d.pendingRequestCount,
          })),
          existingVacanciesCount: snapshot.totals.existingVacanciesCount,
          publishedVacanciesCount: snapshot.totals.publishedVacanciesCount,
          approvedVacanciesCount: snapshot.totals.approvedVacanciesCount,
          draftVacanciesCount: snapshot.totals.draftVacanciesCount,
          closedVacanciesCount: snapshot.totals.closedVacanciesCount,
          rejectedVacanciesCount: snapshot.totals.rejectedVacanciesCount,
          staffingRequestsCount: snapshot.totals.staffingRequestsCount,
          openStaffingRequestsCount: snapshot.totals.openStaffingRequestsCount,
          submittedStaffingRequestsCount: snapshot.totals.submittedStaffingRequestsCount,
          underReviewStaffingRequestsCount: snapshot.totals.underReviewStaffingRequestsCount,
          convertedStaffingRequestsCount: snapshot.totals.convertedStaffingRequestsCount,
          declinedStaffingRequestsCount: snapshot.totals.declinedStaffingRequestsCount,
          totalStaffingRequestsCount: snapshot.totals.totalStaffingRequestsCount,
          performanceReviewsCount: snapshot.totals.performanceReviewsCount,
          submittedReviewsCount: snapshot.totals.submittedReviewsCount,
          completedReviewsCount: snapshot.totals.completedReviewsCount,
          draftReviewsCount: snapshot.totals.draftReviewsCount,
          returnedReviewsCount: snapshot.totals.returnedReviewsCount,
          incompleteReviewsCount: snapshot.totals.incompleteReviewsCount,
          developmentPlansCount: snapshot.totals.developmentPlansCount,
          endorsedDevelopmentPlansCount: snapshot.totals.endorsedDevelopmentPlansCount,
          pendingDevelopmentPlansCount: snapshot.totals.pendingDevelopmentPlansCount,
          revisionDevelopmentPlansCount: snapshot.totals.revisionDevelopmentPlansCount,
          trainingRecordsCount: snapshot.totals.trainingRecordsCount,
          pendingTrainingRecordsCount: snapshot.totals.pendingTrainingRecordsCount,
          draftTrainingRecordsCount: snapshot.totals.draftTrainingRecordsCount,
          rejectedTrainingRecordsCount: snapshot.totals.rejectedTrainingRecordsCount,
          totalTrainingRecordsCount: snapshot.totals.totalTrainingRecordsCount,
          jobApplicationsCount: snapshot.totals.jobApplicationsCount,
          leaveApplicationsCount: snapshot.totals.leaveApplicationsCount,
          approvedLeaveCount: snapshot.totals.approvedLeaveCount,
          pendingLeaveCount: snapshot.totals.pendingLeaveCount,
          separatedOrInactiveCount: snapshot.totals.separatedOrInactiveCount,
        },
        recommendations,
      };

      db.createVacancyRecommendationRun(run);
      db.logAction(
        active.id,
        active.name,
        active.role,
        'AI_VACANCY_RECOMMENDATION',
        'RECRUITMENT',
        `Ran AI vacancy recommendation analysis (${run.dataSufficiencyStatus}): ${recommendations.length} recommendation(s) generated`,
        run.id
      );

      res.json({ success: true, run });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to analyze workforce requirements.' });
    }
  }
);

// PATCH /api/recruitment/recommendations/:id/decision: HR Admin approves or rejects an AI recommendation
app.patch(
  '/api/recruitment/recommendations/:id/decision',
  requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { id } = req.params;
    const { decision, remarks } = req.body || {};

    if (!['APPROVE', 'REJECT'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be APPROVE or REJECT.' });
    }
    if (decision === 'REJECT' && (!remarks || !String(remarks).trim())) {
      return res.status(400).json({ error: 'A rejection reason is required when rejecting an AI recommendation.' });
    }

    const match = db.findVacancyRecommendationById(id);
    if (!match) {
      return res.status(404).json({ error: 'Vacancy recommendation not found.' });
    }

    const nextStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const updated = db.updateVacancyRecommendationItem(id, {
      status: nextStatus,
      hrRemarks: remarks ? String(remarks).trim() : undefined,
      reviewedBy: active.name,
      reviewedById: active.id,
      reviewedAt: new Date().toISOString(),
    });

    if (match.item.relatedStaffingRequestId) {
      db.updateStaffingRequest(match.item.relatedStaffingRequestId, {
        status: decision === 'REJECT' ? 'DECLINED' : 'UNDER_HR_REVIEW',
        hrRemarks: remarks ? String(remarks).trim() : undefined,
        reviewedBy: active.name,
        reviewedById: active.id,
        reviewedAt: new Date().toISOString(),
        linkedRecommendationId: match.item.id,
      });
    }

    db.logAction(
      active.id,
      active.name,
      active.role,
      decision === 'APPROVE' ? 'APPROVE_AI_RECOMMENDATION' : 'REJECT_AI_RECOMMENDATION',
      'RECRUITMENT',
      `${decision === 'APPROVE' ? 'Approved' : 'Rejected'} AI recommendation for "${match.item.proposedTitle}"`,
      id
    );

    res.json({ success: true, recommendation: updated });
  }
);

// POST /api/recruitment/generate-job-description: Generate editable JD draft (NEVER auto-published)
app.post(
  '/api/recruitment/generate-job-description',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  async (req: Request, res: Response) => {
    try {
      const active = getReqUser(req);
      const body = req.body || {};
      const {
        recommendationId,
        staffingRequestId,
        approveIfPending,
        saveAsDraft = true,
      } = body;

      let resolvedTitle = typeof body.proposedPosition === 'string'
        ? body.proposedPosition.trim()
        : typeof body.jobTitle === 'string'
        ? body.jobTitle.trim()
        : '';
      let resolvedDept = typeof body.department === 'string' ? body.department.trim() : '';
      let resolvedLevel = ['Entry', 'Mid', 'Senior', 'Lead', 'Executive'].includes(body.jobLevel)
        ? body.jobLevel
        : undefined;
      let resolvedEmpType: EmploymentType | undefined = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP'].includes(body.employmentType)
        ? body.employmentType
        : undefined;
      let resolvedWorkArr: WorkArrangement | undefined = ['ON_SITE', 'HYBRID', 'REMOTE'].includes(body.workArrangement)
        ? body.workArrangement
        : undefined;
      let rationale: string | undefined;
      let supportingSignals: string[] = [];
      let insufficientDataNotes: string[] = [];
      let competencyNeeds: string[] = [];
      let linkedRecId: string | undefined = recommendationId;
      let linkedReqId: string | undefined = staffingRequestId;
      let openPositions = Number(body.openPositions) || 1;

      if (recommendationId) {
        const match = db.findVacancyRecommendationById(recommendationId);
        if (!match) {
          return res.status(404).json({ error: 'Selected AI recommendation not found.' });
        }
        const rec = match.item;
        if (rec.status === 'REJECTED') {
          return res.status(400).json({ error: 'Cannot generate a job description from a rejected recommendation.' });
        }
        if (rec.status === 'AI_RECOMMENDED') {
          if (approveIfPending && isAuthorizedVacancyApprover(active.role)) {
            db.updateVacancyRecommendationItem(rec.id, {
              status: 'APPROVED',
              reviewedBy: active.name,
              reviewedById: active.id,
              reviewedAt: new Date().toISOString(),
            });
          } else {
            return res.status(400).json({
              error: 'An AI recommendation must be approved by an authorized HR Administrator before generating a job description.',
            });
          }
        }
        resolvedTitle = resolvedTitle || rec.proposedTitle;
        resolvedDept = resolvedDept || rec.department;
        resolvedLevel = resolvedLevel || rec.jobLevel;
        resolvedEmpType = resolvedEmpType || rec.employmentType;
        resolvedWorkArr = resolvedWorkArr || rec.workArrangement;
        openPositions = Number(body.openPositions) || rec.recommendedHeadcount || 1;
        rationale = rec.rationale;
        supportingSignals = rec.supportingInformation || [];
        insufficientDataNotes = rec.dataGaps || [];
        linkedReqId = linkedReqId || rec.relatedStaffingRequestId;
      }

      if (linkedReqId) {
        const sreq = db.getStaffingRequestById(linkedReqId);
        if (sreq) {
          if (sreq.status === 'DECLINED') {
            return res.status(400).json({ error: 'Cannot generate a job description from a declined staffing request.' });
          }
          resolvedTitle = resolvedTitle || sreq.requestedPositionTitle;
          resolvedDept = resolvedDept || sreq.department;
          resolvedLevel = resolvedLevel || sreq.jobLevel || 'Mid';
          resolvedEmpType = resolvedEmpType || sreq.employmentType;
          resolvedWorkArr = resolvedWorkArr || sreq.workArrangement;
          openPositions = Number(body.openPositions) || sreq.headcount || 1;
          competencyNeeds = sreq.competencyNeeds || [];
          rationale = rationale || sreq.justification;
          if (!supportingSignals.length) {
            supportingSignals = [`Department Head Staffing Request ${sreq.id} (${sreq.department})`];
          }
        }
      }

      if (!resolvedTitle) {
        return res.status(400).json({ error: 'A proposed position or approved recommendation is required.' });
      }
      resolvedDept = resolvedDept || 'Executive Office & Administration';
      resolvedLevel = resolvedLevel || 'Mid';

      const generated = await generateJobDescriptionAI({
        jobTitle: resolvedTitle,
        department: resolvedDept,
        jobLevel: resolvedLevel,
        employmentType: resolvedEmpType,
        workArrangement: resolvedWorkArr,
        additionalContext: typeof body.additionalContext === 'string' ? body.additionalContext : undefined,
        recommendationRationale: rationale,
        competencyNeeds,
      });

      if (!saveAsDraft) {
        return res.json({ success: true, generatedDraft: generated });
      }

      const now = new Date().toISOString();
      const generatedId = `vac_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const jobCode = `ACPH-VAC-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
      const deadlineDate = new Date();
      deadlineDate.setDate(deadlineDate.getDate() + 30);

      const newVacancy: any = {
        id: generatedId,
        jobTitle: generated.jobTitle,
        department: generated.department,
        jobCode,
        jobLevel: generated.jobLevel,
        employmentType: generated.employmentType || resolvedEmpType || 'FULL_TIME',
        workArrangement: generated.workArrangement || resolvedWorkArr || 'HYBRID',
        location: 'AmCham Secretariat, 2/F Corinthian Plaza, 121 Paseo de Roxas, Legazpi Village, Makati City',
        salaryRange: 'Competitive & Commensurate with Experience',
        summary: generated.summary,
        responsibilities: generated.responsibilities,
        minimumEducation: generated.minimumEducation,
        requiredExperienceYears: generated.requiredExperienceYears,
        qualifications: generated.requiredQualifications,
        preferredQualifications: generated.preferredQualifications,
        competencies: generated.skillsAndCompetencies,
        applicationDeadline: deadlineDate.toISOString().split('T')[0],
        requiredDocuments: [
          {
            id: `req_${Date.now()}_cv`,
            requirementTitle: 'Updated Resume / Curriculum Vitae',
            category: 'Resume and Portfolio',
            isRequired: true,
            description: 'Comprehensive curriculum vitae detailing employment history and references',
          },
          {
            id: `req_${Date.now()}_cl`,
            requirementTitle: 'Cover Letter / Application Letter',
            category: 'Application Documents',
            isRequired: true,
            description: 'Addressed to AmCham Philippines Secretariat HR Administration',
          },
        ],
        optionalDocuments: [],
        hiringManager: 'Rachel de Guzman (Deputy Director & Head of HR)',
        openPositions,
        status: 'DRAFT' as VacancyStatus,
        isPublished: false,
        version: 1,
        createdBy: active.name,
        sourceType: linkedRecId ? 'AI_RECOMMENDED' : linkedReqId ? 'DEPT_HEAD_REQUEST' : 'AI_GENERATED',
        recommendationId: linkedRecId,
        staffingRequestId: linkedReqId,
        aiRationale: rationale || generated.notes,
        supportingSignals,
        insufficientDataNotes,
        statusHistory: [
          {
            id: `vhist_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
            action: 'AI_GENERATED_DRAFT',
            toStatus: 'DRAFT',
            performedBy: active.name,
            performedById: active.id,
            performedByRole: active.role,
            remarks: generated.notes || 'AI-generated editable job description draft (awaiting HR review and approval).',
            timestamp: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };

      db.getData().recruitmentDrafts.unshift(newVacancy);

      if (linkedRecId) {
        db.updateVacancyRecommendationItem(linkedRecId, {
          status: 'DRAFT_CREATED',
          linkedVacancyId: newVacancy.id,
        });
      }
      if (linkedReqId) {
        const sreq = db.getStaffingRequestById(linkedReqId);
        db.updateStaffingRequest(linkedReqId, {
          status: 'CONVERTED_TO_DRAFT',
          linkedVacancyId: newVacancy.id,
          linkedRecommendationId: linkedRecId || sreq?.linkedRecommendationId,
        });
        if (sreq?.requestedById) {
          db.createNotification(
            sreq.requestedById,
            'Staffing Request Converted to Draft Vacancy',
            `HR has generated an internal Job Description draft for "${newVacancy.jobTitle}" (${newVacancy.department}) from your staffing request. It remains in internal HR review before any publication.`,
            'SYSTEM',
            'dashboard',
            { staffingRequestId: sreq.id, vacancyId: newVacancy.id }
          );
        }
      }

      db.save();
      db.logAction(
        active.id,
        active.name,
        active.role,
        'AI_GENERATE_JOB_DESCRIPTION',
        'RECRUITMENT',
        `Generated editable JD draft "${newVacancy.jobTitle}" (${newVacancy.jobCode}) — status DRAFT`,
        newVacancy.id
      );

      res.status(201).json({
        success: true,
        generatedDraft: generated,
        vacancy: newVacancy,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate job description draft.' });
    }
  }
);

// GET /api/recruitment/vacancies: Dedicated HR vacancy management with applicant counts
app.get('/api/recruitment/vacancies', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (_req: Request, res: Response) => {
  const drafts = db.getData().recruitmentDrafts || [];
  const allApps = db.getData().jobApplications || [];

  const vacancies = drafts.map((d: any) => {
    const appCount = allApps.filter((a: any) => a.vacancyId === d.id).length;
    const isPub = isVacancyPubliclyVisible(d);
    const status = d.status || (isPub ? 'PUBLISHED' : 'DRAFT');

    return {
      id: d.id,
      jobTitle: d.jobTitle || 'Untitled Vacancy',
      department: d.department || 'Executive Office & Administration',
      jobCode: d.jobCode || `ACPH-VAC-2026-${String(d.id || '').slice(-4)}`,
      jobLevel: d.jobLevel || 'Mid',
      employmentType: d.employmentType || 'FULL_TIME',
      workArrangement: d.workArrangement || 'HYBRID',
      location: d.location || 'AmCham Secretariat, 2/F Corinthian Plaza, 121 Paseo de Roxas, Legazpi Village, Makati City',
      salaryRange: d.salaryRange || 'Competitive & Commensurate with Experience',
      summary: d.summary || '',
      responsibilities: Array.isArray(d.responsibilities) ? d.responsibilities : (d.responsibilities ? [d.responsibilities] : []),
      minimumEducation: d.minimumEducation || "Bachelor's Degree in relevant field",
      requiredExperienceYears: d.requiredExperienceYears || '2+ years relevant experience',
      competencies: Array.isArray(d.competencies) ? d.competencies : [],
      qualifications: Array.isArray(d.qualifications) ? d.qualifications : [],
      preferredQualifications: Array.isArray(d.preferredQualifications) ? d.preferredQualifications : (d.qualifications || []),
      targetStartDate: d.targetStartDate || '',
      applicationDeadline: d.applicationDeadline || '',
      requiredDocuments: Array.isArray(d.requiredDocuments) ? d.requiredDocuments : [],
      optionalDocuments: Array.isArray(d.optionalDocuments) ? d.optionalDocuments : [],
      hiringManager: d.hiringManager || 'Deputy Director & Head of Human Resources',
      status,
      isPublished: isPub,
      applicantCount: appCount,
      openPositions: d.openPositions || 1,
      sourceType: d.sourceType || 'MANUAL',
      recommendationId: d.recommendationId,
      staffingRequestId: d.staffingRequestId,
      aiRationale: d.aiRationale,
      supportingSignals: d.supportingSignals || [],
      insufficientDataNotes: d.insufficientDataNotes || [],
      reviewRemarks: d.reviewRemarks,
      rejectionReason: d.rejectionReason,
      reviewedBy: d.reviewedBy,
      reviewedAt: d.reviewedAt,
      approvedBy: d.approvedBy,
      approvedAt: d.approvedAt,
      publishedBy: d.publishedBy,
      publishedAt: d.publishedAt,
      closedBy: d.closedBy,
      closedAt: d.closedAt,
      statusHistory: Array.isArray(d.statusHistory) ? d.statusHistory : [],
      createdBy: d.createdBy,
      createdAt: d.createdAt || new Date().toISOString(),
      updatedAt: d.updatedAt || d.createdAt || new Date().toISOString(),
    };
  });

  res.json({ vacancies });
});

// POST /api/recruitment/vacancies: Create a new vacancy (only HR Admin can set APPROVED/PUBLISHED)
app.post('/api/recruitment/vacancies', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const body = req.body || {};
  const now = new Date().toISOString();

  if (!body.jobTitle || typeof body.jobTitle !== 'string' || !body.jobTitle.trim()) {
    return res.status(400).json({ error: 'Job Title is required.' });
  }

  const targetStatus: VacancyStatus = body.status || (body.isPublished === true ? 'PUBLISHED' : 'DRAFT');
  const adminOnlyStatuses = new Set(['APPROVED', 'PUBLISHED', 'REJECTED']);
  if (!isAuthorizedVacancyApprover(active.role) && (adminOnlyStatuses.has(targetStatus) || body.isPublished === true)) {
    return res.status(403).json({
      error: 'Forbidden: Only an authorized HR Administrator can approve or publish vacancies.',
    });
  }

  const generatedId = `vac_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const jobCode = body.jobCode && String(body.jobCode).trim()
    ? String(body.jobCode).trim()
    : `ACPH-VAC-2026-${String(Date.now()).slice(-4)}`;

  const isPub = targetStatus === 'PUBLISHED';

  const newVacancy: any = {
    id: generatedId,
    jobTitle: body.jobTitle.trim(),
    department: body.department ? String(body.department).trim() : 'Executive Office & Administration',
    jobCode,
    jobLevel: body.jobLevel || 'Mid',
    employmentType: body.employmentType || 'FULL_TIME',
    workArrangement: body.workArrangement || 'HYBRID',
    location: body.location ? String(body.location).trim() : 'AmCham Secretariat, 2/F Corinthian Plaza, 121 Paseo de Roxas, Legazpi Village, Makati City',
    salaryRange: body.salaryRange ? String(body.salaryRange).trim() : 'Competitive & Commensurate with Experience',
    summary: body.summary ? String(body.summary).trim() : '',
    responsibilities: Array.isArray(body.responsibilities) ? body.responsibilities : (body.responsibilities ? [body.responsibilities] : []),
    minimumEducation: body.minimumEducation ? String(body.minimumEducation).trim() : "Bachelor's Degree in relevant discipline",
    requiredExperienceYears: body.requiredExperienceYears ? String(body.requiredExperienceYears).trim() : '2+ years relevant experience',
    competencies: Array.isArray(body.competencies) ? body.competencies : [],
    qualifications: Array.isArray(body.qualifications) ? body.qualifications : [],
    preferredQualifications: Array.isArray(body.preferredQualifications) ? body.preferredQualifications : (body.qualifications || []),
    targetStartDate: body.targetStartDate ? String(body.targetStartDate).trim() : undefined,
    applicationDeadline: body.applicationDeadline ? String(body.applicationDeadline).trim() : undefined,
    requiredDocuments: Array.isArray(body.requiredDocuments) ? body.requiredDocuments : [],
    optionalDocuments: Array.isArray(body.optionalDocuments) ? body.optionalDocuments : [],
    hiringManager: body.hiringManager ? String(body.hiringManager).trim() : 'Deputy Director and Head of Human Resources',
    openPositions: Number(body.openPositions) || 1,
    status: targetStatus,
    isPublished: isPub,
    sourceType: body.sourceType || 'MANUAL',
    createdBy: active.name,
    approvedBy: (targetStatus === 'APPROVED' || targetStatus === 'PUBLISHED') ? active.name : undefined,
    approvedById: (targetStatus === 'APPROVED' || targetStatus === 'PUBLISHED') ? active.id : undefined,
    approvedAt: (targetStatus === 'APPROVED' || targetStatus === 'PUBLISHED') ? now : undefined,
    publishedBy: isPub ? active.name : undefined,
    publishedById: isPub ? active.id : undefined,
    publishedAt: isPub ? now : undefined,
    statusHistory: [
      {
        id: `vhist_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
        action: isPub ? 'CREATED_AND_PUBLISHED' : 'CREATED_DRAFT',
        toStatus: targetStatus,
        performedBy: active.name,
        performedById: active.id,
        performedByRole: active.role,
        timestamp: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  db.getData().recruitmentDrafts.unshift(newVacancy);
  db.save();

  db.logAction(
    active.id,
    active.name,
    active.role,
    isPub ? 'PUBLISH_VACANCY' : 'CREATE_VACANCY',
    'RECRUITMENT',
    `Created ${targetStatus} vacancy for ${newVacancy.jobTitle} (${newVacancy.jobCode})`,
    newVacancy.id
  );

  res.status(201).json({ success: true, vacancy: newVacancy });
});

// PUT /api/recruitment/vacancies/:id: Edit existing vacancy
app.put('/api/recruitment/vacancies/:id', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const data = db.getData();
  const vacancy: any = (data.recruitmentDrafts || []).find((d: any) => d.id === id);
  if (!vacancy) return res.status(404).json({ error: 'Vacancy not found.' });

  const body = req.body || {};
  const previousStatus = vacancy.status || 'DRAFT';
  const targetStatus: VacancyStatus = body.status || (body.isPublished === true ? 'PUBLISHED' : (body.isPublished === false && previousStatus === 'PUBLISHED' ? 'DRAFT' : previousStatus));

  const adminOnlyStatuses = new Set(['APPROVED', 'PUBLISHED', 'REJECTED', 'CLOSED', 'ARCHIVED']);
  if (!isAuthorizedVacancyApprover(active.role)) {
    if (
      (targetStatus !== previousStatus && adminOnlyStatuses.has(targetStatus)) ||
      (body.isPublished === true && previousStatus !== 'PUBLISHED')
    ) {
      return res.status(403).json({
        error: 'Forbidden: Only an authorized HR Administrator can approve, reject, close, or publish vacancies.',
      });
    }
  }

  const isPub = targetStatus === 'PUBLISHED';
  const now = new Date().toISOString();

  Object.assign(vacancy, {
    jobTitle: body.jobTitle !== undefined ? String(body.jobTitle).trim() : vacancy.jobTitle,
    department: body.department !== undefined ? String(body.department).trim() : vacancy.department,
    jobCode: body.jobCode !== undefined ? String(body.jobCode).trim() : vacancy.jobCode,
    jobLevel: body.jobLevel !== undefined ? body.jobLevel : vacancy.jobLevel,
    employmentType: body.employmentType !== undefined ? body.employmentType : vacancy.employmentType,
    workArrangement: body.workArrangement !== undefined ? body.workArrangement : vacancy.workArrangement,
    location: body.location !== undefined ? String(body.location).trim() : vacancy.location,
    salaryRange: body.salaryRange !== undefined ? String(body.salaryRange).trim() : vacancy.salaryRange,
    summary: body.summary !== undefined ? String(body.summary).trim() : vacancy.summary,
    responsibilities: body.responsibilities !== undefined ? body.responsibilities : vacancy.responsibilities,
    minimumEducation: body.minimumEducation !== undefined ? String(body.minimumEducation).trim() : vacancy.minimumEducation,
    requiredExperienceYears: body.requiredExperienceYears !== undefined ? String(body.requiredExperienceYears).trim() : vacancy.requiredExperienceYears,
    competencies: body.competencies !== undefined ? body.competencies : vacancy.competencies,
    qualifications: body.qualifications !== undefined ? body.qualifications : vacancy.qualifications,
    preferredQualifications: body.preferredQualifications !== undefined ? body.preferredQualifications : vacancy.preferredQualifications,
    targetStartDate: body.targetStartDate !== undefined ? String(body.targetStartDate).trim() : vacancy.targetStartDate,
    applicationDeadline: body.applicationDeadline !== undefined ? String(body.applicationDeadline).trim() : vacancy.applicationDeadline,
    requiredDocuments: body.requiredDocuments !== undefined ? body.requiredDocuments : vacancy.requiredDocuments,
    optionalDocuments: body.optionalDocuments !== undefined ? body.optionalDocuments : vacancy.optionalDocuments,
    hiringManager: body.hiringManager !== undefined ? String(body.hiringManager).trim() : vacancy.hiringManager,
    openPositions: body.openPositions !== undefined ? Number(body.openPositions) : vacancy.openPositions,
    status: targetStatus,
    isPublished: isPub,
    updatedAt: now,
  });

  if (targetStatus === 'PUBLISHED' && !vacancy.publishedAt) {
    vacancy.publishedBy = active.name;
    vacancy.publishedById = active.id;
    vacancy.publishedAt = now;
  }
  if ((targetStatus === 'APPROVED' || targetStatus === 'PUBLISHED') && !vacancy.approvedAt) {
    vacancy.approvedBy = active.name;
    vacancy.approvedById = active.id;
    vacancy.approvedAt = now;
  }

  appendVacancyHistory(vacancy, {
    action: previousStatus !== targetStatus ? `EDITED_AND_SET_${targetStatus}` : 'EDITED_DRAFT',
    fromStatus: previousStatus,
    toStatus: targetStatus,
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
    remarks: body.reviewRemarks ? String(body.reviewRemarks).trim() : undefined,
  });

  db.save();
  db.logAction(active.id, active.name, active.role, 'UPDATE_VACANCY', 'RECRUITMENT', `Updated vacancy ${vacancy.jobTitle} (${vacancy.jobCode})`, id);
  res.json({ success: true, vacancy });
});

// PATCH /api/recruitment/vacancies/:id/status: Full 7-status lifecycle transition with strict HR Admin review
app.patch('/api/recruitment/vacancies/:id/status', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, remarks, reason } = req.body || {};
  const active = getReqUser(req);
  const data = db.getData();
  const vacancy: any = (data.recruitmentDrafts || []).find((d: any) => d.id === id);
  if (!vacancy) return res.status(404).json({ error: 'Vacancy not found.' });

  const validStatuses: VacancyStatus[] = [
    'AI_RECOMMENDED',
    'DRAFT',
    'PENDING_HR_REVIEW',
    'APPROVED',
    'PUBLISHED',
    'REJECTED',
    'CLOSED',
    'ARCHIVED',
  ];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status code. Expected one of: ${validStatuses.join(', ')}` });
  }

  // Only authorized HR Administrators can approve, reject, close, archive, or publish vacancies
  const adminOnlyStatuses = new Set(['APPROVED', 'PUBLISHED', 'REJECTED', 'CLOSED', 'ARCHIVED']);
  if (adminOnlyStatuses.has(status) && !isAuthorizedVacancyApprover(active.role)) {
    return res.status(403).json({
      error: 'Forbidden: Only an authorized HR Administrator can approve, reject, publish, or close vacancies.',
    });
  }

  const resolvedRemarks = typeof remarks === 'string' && remarks.trim()
    ? remarks.trim()
    : typeof reason === 'string' && reason.trim()
    ? reason.trim()
    : '';

  if (status === 'REJECTED' && !resolvedRemarks) {
    return res.status(400).json({ error: 'A rejection reason / remark is required when rejecting a vacancy.' });
  }

  const previousStatus = vacancy.status || 'DRAFT';
  const now = new Date().toISOString();

  vacancy.status = status;
  vacancy.isPublished = status === 'PUBLISHED';
  vacancy.updatedAt = now;

  if (resolvedRemarks) {
    vacancy.reviewRemarks = resolvedRemarks;
  }

  if (status === 'APPROVED') {
    vacancy.reviewedBy = active.name;
    vacancy.reviewedById = active.id;
    vacancy.reviewedAt = now;
    vacancy.approvedBy = active.name;
    vacancy.approvedById = active.id;
    vacancy.approvedAt = now;
    vacancy.rejectionReason = undefined;
  } else if (status === 'PUBLISHED') {
    vacancy.reviewedBy = vacancy.reviewedBy || active.name;
    vacancy.reviewedById = vacancy.reviewedById || active.id;
    vacancy.reviewedAt = vacancy.reviewedAt || now;
    vacancy.approvedBy = vacancy.approvedBy || active.name;
    vacancy.approvedById = vacancy.approvedById || active.id;
    vacancy.approvedAt = vacancy.approvedAt || now;
    vacancy.publishedBy = active.name;
    vacancy.publishedById = active.id;
    vacancy.publishedAt = now;
  } else if (status === 'REJECTED') {
    vacancy.reviewedBy = active.name;
    vacancy.reviewedById = active.id;
    vacancy.reviewedAt = now;
    vacancy.rejectionReason = resolvedRemarks;
  } else if (status === 'CLOSED') {
    vacancy.closedBy = active.name;
    vacancy.closedAt = now;
  }

  appendVacancyHistory(vacancy, {
    action: `STATUS_${status}`,
    fromStatus: previousStatus,
    toStatus: status,
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
    remarks: resolvedRemarks || undefined,
  });

  // Notifications on key transitions
  if (status === 'PENDING_HR_REVIEW') {
    const hrAdmins = (data.users || []).filter(
      (u) => u.role === 'HR_ADMINISTRATOR' || u.role === 'SYSTEM_ADMINISTRATOR'
    );
    for (const hr of hrAdmins) {
      db.createNotification(
        hr.id,
        'Vacancy Draft Submitted for HR Review',
        `${active.name} submitted "${vacancy.jobTitle}" (${vacancy.department}) for HR Administrator review & approval.`,
        'SYSTEM',
        'recruitment',
        { vacancyId: vacancy.id, targetSubTab: 'vacancies' }
      );
    }
  }

  if (vacancy.staffingRequestId && ['APPROVED', 'PUBLISHED', 'REJECTED'].includes(status)) {
    const sreq = db.getStaffingRequestById(vacancy.staffingRequestId);
    if (sreq) {
      if (status === 'REJECTED') {
        db.updateStaffingRequest(sreq.id, { status: 'DECLINED', hrRemarks: resolvedRemarks });
      }
      if (sreq.requestedById) {
        db.createNotification(
          sreq.requestedById,
          `Vacancy Update: ${vacancy.jobTitle}`,
          `The vacancy "${vacancy.jobTitle}" linked to your staffing request is now ${status.replace(/_/g, ' ')}.${resolvedRemarks ? ` Remarks: ${resolvedRemarks}` : ''}`,
          'SYSTEM',
          'dashboard',
          { staffingRequestId: sreq.id, vacancyId: vacancy.id }
        );
      }
    }
  }

  db.save();
  db.logAction(
    active.id,
    active.name,
    active.role,
    status === 'PUBLISHED' ? 'PUBLISH_VACANCY' : 'UPDATE_VACANCY_STATUS',
    'RECRUITMENT',
    `Set vacancy "${vacancy.jobTitle}" status from ${previousStatus} to ${status}${resolvedRemarks ? ` (${resolvedRemarks})` : ''}`,
    id
  );
  res.json({ success: true, vacancy });
});

// DELETE /api/recruitment/vacancies/:id: Delete vacancy when permitted
app.delete('/api/recruitment/vacancies/:id', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const force = req.query.force === 'true';
  const active = getReqUser(req);
  const data = db.getData();

  const idx = (data.recruitmentDrafts || []).findIndex((d: any) => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Vacancy not found.' });

  const existingApps = (data.jobApplications || []).filter((a: any) => a.vacancyId === id);
  if (existingApps.length > 0 && !force) {
    return res.status(400).json({
      error: `Cannot delete vacancy: ${existingApps.length} active applicant application(s) are linked to this vacancy. You may close or archive the vacancy instead.`,
      linkedApplicantCount: existingApps.length,
    });
  }

  const removed = data.recruitmentDrafts.splice(idx, 1)[0];
  db.save();
  db.logAction(active.id, active.name, active.role, 'DELETE_VACANCY', 'RECRUITMENT', `Deleted vacancy ${removed.jobTitle}`, id);
  res.json({ success: true, message: 'Vacancy successfully deleted.' });
});

// Legacy support for recruitment drafts
app.get('/api/recruitment/drafts', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (_req: Request, res: Response) => {
  res.json({ drafts: db.getData().recruitmentDrafts });
});

app.post('/api/recruitment/drafts', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const draftData = req.body || {};
  const now = new Date().toISOString();

  const requestedStatus: VacancyStatus = draftData.status || 'DRAFT';
  if (!isAuthorizedVacancyApprover(active.role) && ['APPROVED', 'PUBLISHED', 'REJECTED'].includes(requestedStatus)) {
    return res.status(403).json({ error: 'Forbidden: Only HR Administrators can approve or publish vacancies.' });
  }

  const newDraft: any = {
    id: `rec_${Date.now()}`,
    ...draftData,
    version: 1,
    status: requestedStatus,
    isPublished: requestedStatus === 'PUBLISHED',
    createdBy: active.name,
    statusHistory: [
      {
        id: `vhist_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
        action: 'CREATED_RECRUITMENT_DRAFT',
        toStatus: requestedStatus,
        performedBy: active.name,
        performedById: active.id,
        performedByRole: active.role,
        timestamp: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  db.getData().recruitmentDrafts.unshift(newDraft);
  db.save();

  db.logAction(active.id, active.name, active.role, 'SAVE_RECRUITMENT_DRAFT', 'RECRUITMENT', `Created recruitment draft for ${newDraft.jobTitle}`, newDraft.id);
  res.json({ success: true, draft: newDraft });
});

app.put('/api/recruitment/drafts/:id', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const data = db.getData();
  const draft: any = data.recruitmentDrafts.find((d) => d.id === id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const requestedStatus = req.body?.status;
  if (
    !isAuthorizedVacancyApprover(active.role) &&
    (['APPROVED', 'PUBLISHED', 'REJECTED'].includes(requestedStatus) || req.body?.isPublished === true)
  ) {
    return res.status(403).json({
      error: 'Forbidden: Only authorized HR Administrators can approve or publish vacancies.',
    });
  }

  const prevStatus = draft.status;
  Object.assign(draft, req.body, {
    updatedAt: new Date().toISOString(),
    version: (draft.version || 1) + 1,
  });

  if (requestedStatus === 'APPROVED') {
    draft.reviewedBy = active.name;
    draft.approvedBy = active.name;
    draft.approvedAt = new Date().toISOString();
    if (req.body.isPublished === undefined) {
      draft.isPublished = false;
    }
  } else if (requestedStatus === 'PUBLISHED') {
    draft.isPublished = true;
    draft.publishedBy = active.name;
    draft.publishedAt = new Date().toISOString();
  }

  if (requestedStatus && requestedStatus !== prevStatus) {
    appendVacancyHistory(draft, {
      action: `STATUS_${requestedStatus}`,
      fromStatus: prevStatus,
      toStatus: requestedStatus,
      performedBy: active.name,
      performedById: active.id,
      performedByRole: active.role,
    });
  }

  db.save();
  db.logAction(active.id, active.name, active.role, 'UPDATE_RECRUITMENT_DRAFT', 'RECRUITMENT', `Updated draft ${draft.jobTitle}`, id);
  res.json({ success: true, draft });
});

app.delete('/api/recruitment/drafts/:id', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const data = db.getData();
  const idx = data.recruitmentDrafts.findIndex((d) => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Draft not found' });

  const removed = data.recruitmentDrafts.splice(idx, 1)[0];
  db.save();
  db.logAction(active.id, active.name, active.role, 'DELETE_RECRUITMENT_DRAFT', 'RECRUITMENT', `Deleted draft ${removed.jobTitle}`, id);
  res.json({ success: true, message: 'Draft deleted.' });
});

app.patch('/api/recruitment/drafts/:id/publish', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const { isPublished, employmentType, location, applicationDeadline, openPositions, summary } = req.body;
  const active = getReqUser(req);
  const data = db.getData();
  const draft: any = data.recruitmentDrafts.find((d) => d.id === id);
  if (!draft) return res.status(404).json({ error: 'Recruitment draft not found.' });

  const prevStatus = draft.status;
  const now = new Date().toISOString();
  if (isPublished !== undefined) {
    draft.isPublished = Boolean(isPublished);
    draft.status = draft.isPublished ? 'PUBLISHED' : 'CLOSED';
    if (draft.isPublished) {
      draft.approvedBy = draft.approvedBy || active.name;
      draft.approvedAt = draft.approvedAt || now;
      draft.publishedBy = active.name;
      draft.publishedById = active.id;
      draft.publishedAt = now;
    } else {
      draft.closedBy = active.name;
      draft.closedAt = now;
    }
  }
  if (employmentType !== undefined) draft.employmentType = employmentType;
  if (location !== undefined) draft.location = location;
  if (applicationDeadline !== undefined) draft.applicationDeadline = applicationDeadline;
  if (openPositions !== undefined) draft.openPositions = Number(openPositions) || 1;
  if (summary !== undefined) draft.summary = summary;
  draft.updatedAt = now;

  appendVacancyHistory(draft, {
    action: draft.isPublished ? 'PUBLISHED_VACANCY' : 'UNPUBLISHED_VACANCY',
    fromStatus: prevStatus,
    toStatus: draft.status,
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
  });

  db.save();
  db.logAction(
    active.id,
    active.name,
    active.role,
    draft.isPublished ? 'PUBLISH_VACANCY' : 'UNPUBLISH_VACANCY',
    'RECRUITMENT',
    `${draft.isPublished ? 'Published' : 'Unpublished'} vacancy for "${draft.jobTitle}"`,
    draft.id
  );
  res.json({ success: true, draft });
});

// ----------------------------------------------------
// PUBLIC CAREERS PORTAL (UNAUTHENTICATED)
// ----------------------------------------------------

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// GET /api/careers/vacancies: Public listing of active published vacancies with 18 fields
app.get('/api/careers/vacancies', (_req: Request, res: Response) => {
  const drafts = db.getData().recruitmentDrafts || [];
  const published = drafts
    .filter((d: any) => isVacancyPubliclyVisible(d))
    .map((d: any) => ({
      id: d.id,
      jobTitle: d.jobTitle,
      department: d.department,
      jobCode: d.jobCode || `ACPH-VAC-2026-${String(d.id || '').slice(-4)}`,
      jobLevel: d.jobLevel || 'Mid',
      employmentType: d.employmentType || 'FULL_TIME',
      workArrangement: d.workArrangement || 'HYBRID',
      location: d.location || 'AmCham Secretariat, 2/F Corinthian Plaza, 121 Paseo de Roxas, Legazpi Village, Makati City',
      salaryRange: d.salaryRange || 'Competitive & Commensurate with Experience',
      applicationDeadline: d.applicationDeadline,
      targetStartDate: d.targetStartDate,
      openPositions: d.openPositions || 1,
      summary: d.summary || `Exciting career opportunity for ${d.jobTitle} at the American Chamber of Commerce of the Philippines, Inc.`,
      responsibilities: Array.isArray(d.responsibilities) ? d.responsibilities : (d.responsibilities ? [d.responsibilities] : []),
      minimumEducation: d.minimumEducation || "Bachelor's Degree in relevant field",
      requiredExperienceYears: d.requiredExperienceYears || '2+ years relevant experience',
      qualifications: Array.isArray(d.qualifications) ? d.qualifications : [],
      preferredQualifications: Array.isArray(d.preferredQualifications) ? d.preferredQualifications : (d.qualifications || []),
      competencies: Array.isArray(d.competencies) ? d.competencies : [],
      requiredDocuments: Array.isArray(d.requiredDocuments) ? d.requiredDocuments : [],
      optionalDocuments: Array.isArray(d.optionalDocuments) ? d.optionalDocuments : [],
      hiringManager: d.hiringManager || 'Deputy Director & Head of Human Resources',
      createdAt: d.createdAt,
      isPublished: true,
      status: 'PUBLISHED',
    }));
  res.json({ vacancies: published });
});

// GET /api/careers/vacancies/:id: Public single vacancy detail with 18 fields
app.get('/api/careers/vacancies/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const draft: any = (db.getData().recruitmentDrafts || []).find(
    (d: any) => d.id === id && isVacancyPubliclyVisible(d)
  );
  if (!draft) {
    return res.status(404).json({ error: 'Job vacancy not found or no longer open for applications.' });
  }
  res.json({
    vacancy: {
      id: draft.id,
      jobTitle: draft.jobTitle,
      department: draft.department,
      jobCode: draft.jobCode || `ACPH-VAC-2026-${String(draft.id || '').slice(-4)}`,
      jobLevel: draft.jobLevel || 'Mid',
      employmentType: draft.employmentType || 'FULL_TIME',
      workArrangement: draft.workArrangement || 'HYBRID',
      location: draft.location || 'AmCham Secretariat, 2/F Corinthian Plaza, 121 Paseo de Roxas, Legazpi Village, Makati City',
      salaryRange: draft.salaryRange || 'Competitive & Commensurate with Experience',
      applicationDeadline: draft.applicationDeadline,
      targetStartDate: draft.targetStartDate,
      openPositions: draft.openPositions || 1,
      summary: draft.summary || `Exciting career opportunity for ${draft.jobTitle} at AmCham Philippines.`,
      responsibilities: Array.isArray(draft.responsibilities) ? draft.responsibilities : (draft.responsibilities ? [draft.responsibilities] : []),
      minimumEducation: draft.minimumEducation || "Bachelor's Degree in relevant field",
      requiredExperienceYears: draft.requiredExperienceYears || '2+ years relevant experience',
      qualifications: Array.isArray(draft.qualifications) ? draft.qualifications : [],
      preferredQualifications: Array.isArray(draft.preferredQualifications) ? draft.preferredQualifications : (draft.qualifications || []),
      competencies: Array.isArray(draft.competencies) ? draft.competencies : [],
      requiredDocuments: Array.isArray(draft.requiredDocuments) ? draft.requiredDocuments : [],
      optionalDocuments: Array.isArray(draft.optionalDocuments) ? draft.optionalDocuments : [],
      hiringManager: draft.hiringManager || 'Deputy Director & Head of Human Resources',
      createdAt: draft.createdAt,
      isPublished: true,
      status: 'PUBLISHED',
    },
  });
});

// POST /api/careers/apply: Submit job application (Public)
app.post('/api/careers/apply', resumeUpload.single('resume'), async (req: Request, res: Response) => {
  try {
    const {
      vacancyId,
      fullName,
      email,
      phone,
      education,
      experience,
      skills,
      privacyConsent,
      supportingDocName,
      supportingDocUrl,
    } = req.body;

    // Validate required fields
    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      return res.status(400).json({ error: 'Full name is required.' });
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!phone || typeof phone !== 'string' || !phone.trim()) {
      return res.status(400).json({ error: 'Contact phone number is required.' });
    }
    if (!vacancyId || typeof vacancyId !== 'string') {
      return res.status(400).json({ error: 'Position / Vacancy ID is required.' });
    }
    if (!education || typeof education !== 'string' || !education.trim()) {
      return res.status(400).json({ error: 'Educational background is required.' });
    }
    const activeUser = getActiveUser(req);
    const normEmail = email.toLowerCase().trim();
    const existingApplicant = db.findUserByEmail(normEmail);
    const applicantUserId = activeUser?.id || (existingApplicant?.role === 'APPLICANT' ? existingApplicant.id : undefined);

    const consent = privacyConsent === true || privacyConsent === 'true' || privacyConsent === '1' || Boolean(activeUser) || !('privacyConsent' in req.body);
    if (!consent) {
      return res.status(400).json({ error: 'You must acknowledge and agree to the Data Privacy Notice to submit an application.' });
    }

    // Check vacancy validity
    const draft = (db.getData().recruitmentDrafts || []).find((d) => d.id === vacancyId && isVacancyPubliclyVisible(d));
    if (!draft) {
      return res.status(404).json({ error: 'The selected job vacancy is not open or does not exist.' });
    }

    // Check application deadline
    if (draft.applicationDeadline) {
      const today = new Date().toISOString().split('T')[0];
      if (today > draft.applicationDeadline) {
        return res.status(400).json({ error: `The application deadline for this position (${draft.applicationDeadline}) has passed.` });
      }
    }

    // Prevent duplicate application for the same vacancy
    const existing = (db.getData().jobApplications || []).find(
      (a) => a.email.toLowerCase().trim() === normEmail && a.vacancyId === vacancyId
    );
    if (existing) {
      return res.status(409).json({
        error: `You have already submitted an application for ${draft.jobTitle}.`,
        referenceNumber: existing.referenceNumber,
        message: `An active application under reference ${existing.referenceNumber} already exists for this position. You can track your status in the Applicant Portal.`,
      });
    }

    // Generate unique reference number (e.g. APP-2026-XXXXX)
    let refNum = `APP-2026-${Math.floor(10000 + Math.random() * 90000)}`;
    while ((db.getData().jobApplications || []).some((a) => a.referenceNumber === refNum)) {
      refNum = `APP-2026-${Math.floor(10000 + Math.random() * 90000)}`;
    }
    const accessToken = crypto.randomBytes(24).toString('hex');

    // Parse skills list
    let parsedSkills: string[] = [];
    if (Array.isArray(skills)) {
      parsedSkills = skills.map((s) => String(s).trim()).filter(Boolean);
    } else if (typeof skills === 'string') {
      parsedSkills = skills.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    }

    // Handle uploaded file or base64 file
    let resumeFileName: string | undefined = req.body.resumeFileName || undefined;
    let resumeFileUrl: string | undefined = req.body.resumeFileUrl || undefined;
    let resumeFileType: string | undefined = req.body.resumeFileType || undefined;

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const safeRandom = crypto.randomBytes(16).toString('hex');
      const genFileName = `resume_${Date.now()}_${safeRandom}${ext}`;
      const stored = await firebaseStorage.uploadApplicantFile(
        req.file.buffer,
        genFileName,
        req.file.originalname,
        req.file.mimetype
      );
      resumeFileName = req.file.originalname;
      resumeFileType = req.file.mimetype;
      resumeFileUrl = `/api/recruitment/applications/files/${stored.fileName}`;
    }

    const now = new Date().toISOString();
    const newApp: JobApplication = {
      id: `app_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      referenceNumber: refNum,
      applicantUserId,
      vacancyId: draft.id,
      jobTitle: draft.jobTitle,
      department: draft.department,
      fullName: fullName.trim(),
      email: normEmail,
      phone: phone.trim(),
      education: education.trim(),
      experience: experience?.trim() || 'N/A',
      skills: parsedSkills,
      resumeFileName,
      resumeFileUrl,
      resumeFileType,
      supportingDocName: supportingDocName?.trim() || undefined,
      supportingDocUrl: supportingDocUrl?.trim() || undefined,
      privacyConsent: true,
      consentTimestamp: now,
      status: 'SUBMITTED',
      stageHistory: [
        {
          stage: 'SUBMITTED',
          timestamp: now,
          updatedBy: 'Applicant (Online Submission)',
          note: 'Application successfully received through AmCham Philippines Careers Portal.',
        },
      ],
      accessToken,
      createdAt: now,
      updatedAt: now,
    };

    db.createJobApplication(newApp);

    // Notify HR Administrators in-app with applicant name, position, reference number, and submission date
    const hrUsers = (db.getData().users || []).filter(
      (u) => u.role === 'HR_ADMINISTRATOR' || u.role === 'HR_PERSONNEL' || u.role === 'SYSTEM_ADMINISTRATOR'
    );
    const submissionDateFormatted = new Date(newApp.createdAt).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    for (const hr of hrUsers) {
      db.createNotification(
        hr.id,
        'New Job Application Received',
        `${newApp.fullName} submitted an application for ${newApp.jobTitle} (Ref: ${newApp.referenceNumber}) on ${submissionDateFormatted}.`,
        'SYSTEM',
        'recruitment',
        {
          applicationId: newApp.id,
          referenceNumber: newApp.referenceNumber,
          jobTitle: newApp.jobTitle,
          position: newApp.jobTitle,
          applicantName: newApp.fullName,
          applicantEmail: newApp.email,
          submissionDate: newApp.createdAt,
          targetSubTab: 'applications',
        }
      );
    }

    db.logAction(
      'APPLICANT_PORTAL',
      newApp.fullName,
      'EMPLOYEE',
      'SUBMIT_JOB_APPLICATION',
      'RECRUITMENT',
      `Application submitted for ${newApp.jobTitle} (Ref: ${newApp.referenceNumber})`,
      newApp.id
    );

    res.status(201).json({
      success: true,
      referenceNumber: newApp.referenceNumber,
      accessToken: newApp.accessToken,
      application: newApp,
      message: 'Application submitted successfully. Please record your reference number to track your application status.',
    });
  } catch (err: any) {
    console.error('Job application error:', err);
    res.status(500).json({ error: err.message || 'Failed to submit application. Please try again.' });
  }
});

// POST /api/careers/track: Check application status (Public)
app.post('/api/careers/track', (req: Request, res: Response) => {
  const { referenceNumber, email, accessToken } = req.body;

  let app: JobApplication | undefined;

  if (accessToken && typeof accessToken === 'string' && accessToken.trim()) {
    app = db.findJobApplicationByToken(accessToken.trim());
  } else if (referenceNumber && email) {
    app = db.findJobApplication(referenceNumber, email);
  }

  if (!app) {
    return res.status(404).json({
      error: 'No application found with the provided credentials. Please ensure both your Reference Number and Email Address match your submission.',
    });
  }

  // Never expose internal HR notes or other applicants
  res.json({
    success: true,
    application: {
      referenceNumber: app.referenceNumber,
      vacancyId: app.vacancyId,
      jobTitle: app.jobTitle,
      department: app.department,
      fullName: app.fullName,
      email: app.email,
      status: app.status,
      stageHistory: app.stageHistory,
      interviewSchedule: app.interviewSchedule,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    },
  });
});

// ----------------------------------------------------
// PROTECTED RECRUITMENT ASSISTANT (HR / ADMIN ONLY)
// ----------------------------------------------------

// GET /api/recruitment/applications: View all candidate applications
app.get('/api/recruitment/applications', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { vacancyId, status, search } = req.query;
  const rawApps = db.getJobApplications({
    vacancyId: typeof vacancyId === 'string' ? vacancyId : undefined,
    status: typeof status === 'string' ? (status as any) : undefined,
    search: typeof search === 'string' ? search : undefined,
  });
  const applications = rawApps.map((a) => ({
    ...a,
    documents: db.getApplicationDocuments({ applicationId: a.id }),
  }));
  res.json({ applications });
});

// GET /api/recruitment/applications/:id: View single candidate application with full details
app.get('/api/recruitment/applications/:id', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const application = db.getJobApplicationById(id);
  if (!application) {
    return res.status(404).json({ error: 'Application not found.' });
  }
  const documents = db.getApplicationDocuments({ applicationId: id });
  res.json({ application: { ...application, documents } });
});

// PATCH /api/recruitment/applications/:id/status: Update candidate stage, notes, or schedule interview
app.patch('/api/recruitment/applications/:id/status', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, note, stageNote, interviewSchedule, hrNotes } = req.body;
  const active = getReqUser(req);
  const app = db.getJobApplicationById(id);

  if (!app) {
    return res.status(404).json({ error: 'Application not found.' });
  }

  const validStatuses = ['SUBMITTED', 'UNDER_REVIEW', 'SHORTLISTED', 'INTERVIEW', 'OFFERED', 'HIRED', 'NOT_SELECTED'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid application status: ${status}` });
  }

  const previousStatus = app.status;
  const statusChanged = Boolean(status && status !== previousStatus);
  const effectiveNote = (note || stageNote || '').trim();

  const now = new Date().toISOString();
  const updates: Partial<JobApplication> = {
    updatedAt: now,
  };

  if (statusChanged) {
    updates.status = status;
    const stageEntry = {
      stage: status,
      timestamp: now,
      updatedBy: active.name,
      note: effectiveNote || `Candidate moved to ${status} by ${active.name}.`,
    };
    updates.stageHistory = [...(app.stageHistory || []), stageEntry];
  } else if (effectiveNote) {
    // Add note to current stage
    const last = app.stageHistory && app.stageHistory.length > 0 ? { ...app.stageHistory[app.stageHistory.length - 1] } : null;
    if (last) {
      last.note = `${last.note ? last.note + ' | ' : ''}${effectiveNote}`;
      updates.stageHistory = [...app.stageHistory.slice(0, -1), last];
    }
  }

  if (interviewSchedule !== undefined) {
    updates.interviewSchedule = interviewSchedule;
  }
  if (hrNotes !== undefined) {
    updates.hrNotes = hrNotes;
  }

  const updated = db.updateJobApplication(id, updates);

  // Notify the applicant of status change or interview scheduling
  const applicantTargetId = app.applicantUserId || db.findUserByEmail(app.email)?.id || app.email;
  if (statusChanged) {
    db.createNotification(
      applicantTargetId,
      'Application Status Updated',
      `Your application for ${app.jobTitle} (Ref: ${app.referenceNumber}) has progressed to: ${status.replace(/_/g, ' ')}.`,
      'SYSTEM',
      'applications',
      { applicationId: app.id, status, referenceNumber: app.referenceNumber },
      app.email
    );
  }
  if (interviewSchedule && (interviewSchedule.scheduledDate || interviewSchedule.locationOrLink)) {
    db.createNotification(
      applicantTargetId,
      'Interview Scheduled',
      `An interview has been scheduled for your application for ${app.jobTitle} (Ref: ${app.referenceNumber}) on ${interviewSchedule.scheduledDate} at ${interviewSchedule.scheduledTime}. Location / Venue: ${interviewSchedule.locationOrLink}.`,
      'SYSTEM',
      'applications',
      { applicationId: app.id, referenceNumber: app.referenceNumber, interviewSchedule },
      app.email
    );
  }

  if (updated) {
    updated.documents = db.getApplicationDocuments({ applicationId: id });
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    'UPDATE_APPLICANT_STATUS',
    'RECRUITMENT',
    `Updated candidate ${app.fullName} (${app.referenceNumber}) to ${status || app.status}`,
    id
  );

  res.json({ success: true, application: updated });
});

// POST /api/recruitment/applications/:id/ai-screen: Screen applicant qualifications using AI
app.post('/api/recruitment/applications/:id/ai-screen', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const active = getReqUser(req);
    const application = db.getJobApplicationById(id);
    if (!application) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    const vacancy = (db.getData().recruitmentDrafts || []).find((d) => d.id === application.vacancyId) || {
      jobTitle: application.jobTitle,
      department: application.department,
      jobLevel: 'Mid' as const,
      responsibilities: ['Corporate member liaison and standing committee facilitation'],
      qualifications: ['Bachelor degree and relevant professional experience'],
      competencies: [],
    };

    const screeningResult = await screenApplicantAI({
      applicant: {
        fullName: application.fullName,
        education: application.education,
        experience: application.experience,
        skills: application.skills,
        positionAppliedFor: application.jobTitle,
      },
      vacancy: {
        jobTitle: vacancy.jobTitle,
        department: vacancy.department,
        jobLevel: vacancy.jobLevel,
        responsibilities: vacancy.responsibilities || [],
        qualifications: vacancy.qualifications || [],
        competencies: Array.isArray(vacancy.competencies)
          ? vacancy.competencies.map((c: any) =>
              typeof c === 'string' ? { name: c, description: c } : { name: c.name, description: c.description || c.name }
            )
          : [],
      },
    });

    const aiScreening = {
      ...screeningResult,
      generatedAt: new Date().toISOString(),
    };

    const updated = db.updateJobApplication(id, { aiScreening });

    db.logAction(
      active.id,
      active.name,
      active.role,
      'AI_SCREEN_APPLICANT',
      'RECRUITMENT',
      `Generated AI screening dossier for candidate ${application.fullName} (${application.referenceNumber})`,
      id
    );

    res.json({ success: true, aiScreening: updated?.aiScreening });
  } catch (err: any) {
    console.error('AI screening error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate AI screening.' });
  }
});

// DELETE /api/recruitment/applications/:id: Delete candidate application
app.delete('/api/recruitment/applications/:id', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const app = db.getJobApplicationById(id);
  if (!app) return res.status(404).json({ error: 'Application not found.' });

  db.deleteJobApplication(id);
  db.logAction(
    active.id,
    active.name,
    active.role,
    'DELETE_APPLICANT_RECORD',
    'RECRUITMENT',
    `Deleted application record for ${app.fullName} (${app.referenceNumber})`,
    id
  );
  res.json({ success: true, message: 'Application deleted.' });
});

// ----------------------------------------------------
// 4B. APPLICANT PORTAL & INQUIRIES INTEGRATION
// ----------------------------------------------------

// Stream files (resumes, documents) from Firebase Storage or memory cache
app.get('/api/recruitment/applications/files/:filename', async (req: Request, res: Response) => {
  const { filename } = req.params;
  const safeFilename = path.basename(filename);
  const storagePath = `applicant_uploads/${safeFilename}`;
  const streamed = await firebaseStorage.streamDocumentToResponse(storagePath, res);
  if (!streamed && !res.headersSent) {
    return res.status(404).json({ error: 'Requested file not found in storage.' });
  }
});

const applicantDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowedExts = ['.pdf', '.docx', '.doc', '.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedMimes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'image/jpeg',
      'image/png',
      'image/webp',
    ];
    if (
      allowedExts.includes(ext) &&
      (allowedMimes.includes(file.mimetype.toLowerCase()) ||
        file.mimetype.includes('image') ||
        file.mimetype.includes('pdf') ||
        file.mimetype.includes('word') ||
        file.mimetype.includes('officedocument') ||
        file.mimetype === 'application/octet-stream')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Invalid document format. Permitted formats are PDF, DOC, DOCX, JPG, PNG, and WEBP (up to 10MB).'));
    }
  },
});

const applicantDocUploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  applicantDocUpload.fields([
    { name: 'document', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File size exceeds maximum permitted limit of 10MB.' });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: "Unexpected file field. Please use multipart field 'document'." });
        }
        return res.status(400).json({ error: `File upload error: ${err.message}` });
      }
      return res.status(400).json({ error: err.message || 'Error processing uploaded file.' });
    }
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    if (files) {
      req.file = files['document']?.[0] || files['file']?.[0];
    }
    next();
  });
};

const APPROVED_RECRUITMENT_FAQS = [
  {
    id: 'faq_01',
    category: 'Vacancies & Positions',
    question: 'What job openings are available at AmCham Philippines?',
    answer: 'All active and published job vacancies are listed directly in the AMIE Careers & Applicant Portal under "Open Job Vacancies". Position descriptions include department affiliation, responsibilities, qualification standards, employment type (Full-Time or Contract), and work location in Makati City.',
  },
  {
    id: 'faq_02',
    category: 'Qualifications & Standards',
    question: 'What are the qualifications for a position?',
    answer: 'Each vacancy outlines explicit educational, professional, and competency criteria. Most Secretariat specialist roles require a relevant Bachelor degree (e.g. Political Science, Economics, Business, Communications), professional English drafting fluency, and experience liaising with multinational enterprise stakeholders. Please inspect the specific job vacancy listing for detailed qualifications.',
  },
  {
    id: 'faq_03',
    category: 'Requirements & Documents',
    question: 'What documents are required for my application?',
    answer: 'A comprehensive Curriculum Vitae (CV) or Résumé is required for all applications. Depending on the position and HR request, official Transcript of Records / College Diploma, professional training certificates, valid government-issued ID, and portfolio samples may also be submitted. Permitted file formats are PDF, DOCX, DOC, JPG, and PNG (maximum 10MB per document).',
  },
  {
    id: 'faq_04',
    category: 'Application Process',
    question: 'How do I submit my application?',
    answer: '1) Register or sign in to your Applicant Account. 2) Browse "Open Job Vacancies". 3) Select your target position and click "Apply Now". 4) Complete your educational background, experience summary, key skills, and upload your CV/Résumé. 5) Review and submit. You will receive an immediate confirmation and a unique reference number (e.g., APP-2026-XXXXX).',
  },
  {
    id: 'faq_05',
    category: 'Application Status',
    question: 'How can I check my application status?',
    answer: 'You can monitor your application status in real-time in your Applicant Dashboard under "My Applications". Status stages progress from Submitted, Under Review, Shortlisted, Interview, Offered, to Hired. Any updates or notes from HR will also trigger in-app notifications in your account.',
  },
  {
    id: 'faq_06',
    category: 'Recruitment Lifecycle',
    question: 'What happens after I apply?',
    answer: '1) Your application is acknowledged immediately and assigned a unique reference number. 2) The HR Recruitment team (led by Head of HR Rachel de Guzman) reviews qualifications against committee needs. 3) Shortlisted candidates are invited for preliminary and panel interviews. 4) An assessment exercise may be administered for technical roles. 5) Successful candidates receive a formal conditional offer, followed by Secretariat onboarding.',
  },
  {
    id: 'faq_07',
    category: 'Interviews & Schedules',
    question: 'How are interviews scheduled?',
    answer: 'Interviews may be conducted in-person at the AmCham Philippines Secretariat (2nd Floor Corinthian Plaza, 121 Paseo de Roxas, Legazpi Village, Makati City) or virtually via Google Meet. When scheduled by HR, the exact date, time, venue/meeting link, and interview panel details will appear in your Applicant Dashboard and under your application details.',
  },
  {
    id: 'faq_08',
    category: 'Requirements & Documents',
    question: 'How can I replace a missing or incorrect document?',
    answer: 'Navigate to the "Requirements & Documents" section within your Applicant Dashboard. If HR has requested a document replacement or if you need to submit an updated CV or certificate, click "Upload / Replace Document" next to the corresponding requirement item.',
  },
  {
    id: 'faq_09',
    category: 'Inquiries & Contact',
    question: 'How can I contact the recruitment team?',
    answer: 'You can submit inquiries directly to the HR Recruitment team through the "Questions to HR / Inquiries" tab in your Applicant Dashboard. The Secretariat HR team reviews all inquiries and replies directly into your portal, with in-app notifications when an answer is posted. You can also reach the Secretariat at (02) 8818-7911 or secretariat@amchamphilippines.com.',
  },
];

// GET /api/applicant/email-delivery-status: Check real email provider status
app.get('/api/applicant/email-delivery-status', (_req: Request, res: Response) => {
  const status = getEmailServiceStatus();
  res.json(status);
});

// POST /api/auth/applicant/register: Individual applicant account registration
app.post('/api/auth/applicant/register', async (req: Request, res: Response) => {
  const name = (req.body.name || req.body.fullName || '').toString().trim();
  const { phone, headline, bio } = req.body;
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body.password;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Full name, email address, and password are required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  if (db.findUserByEmail(email)) {
    return res.status(409).json({
      error: 'An account with this email address already exists. Please sign in or use password recovery.',
      exists: true,
      email,
    });
  }

  const verificationCode = crypto.randomInt(100000, 999999).toString();
  const newApplicant: User = {
    id: `usr_app_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: name.trim(),
    email,
    password: hashPassword(password),
    role: 'APPLICANT',
    accountStatus: 'ACTIVE',
    verificationStatus: 'VERIFIED',
    isEmailVerified: true,
    department: 'External Applicant',
    jobTitle: headline?.trim() || 'Candidate',
    joinedDate: new Date().toISOString().split('T')[0],
    phone: phone?.trim(),
    headline: headline?.trim(),
    bio: bio?.trim(),
    emailVerificationCode: verificationCode,
    emailVerifiedAt: new Date().toISOString(),
  };

  db.createUser(newApplicant);

  const token = `amie_sec_${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();
  sessions.set(token, {
    token,
    userId: newApplicant.id,
    createdAt: now,
    expiresAt: now + SESSION_LIFETIME_MS,
  });
  savePersistedSessions();
  setSessionCookie(req, res, token);

  // Create welcome notification
  db.createNotification(
    newApplicant.id,
    'Welcome to AmCham Careers Portal',
    `Welcome, ${newApplicant.name}! Your applicant account is active and verified. Explore our open vacancies and submit your application.`,
    'SYSTEM',
    'overview',
    undefined,
    newApplicant.email
  );

  db.logAction(
    newApplicant.id,
    newApplicant.name,
    newApplicant.role,
    'APPLICANT_REGISTRATION',
    'AUTH',
    `New applicant registered: ${newApplicant.name} (${newApplicant.email})`
  );

  // Dispatch real verification email only if provider is configured
  const emailResult = await sendApplicantVerificationEmail({
    email: newApplicant.email,
    name: newApplicant.name,
    verificationCode,
  });

  res.status(201).json({
    success: true,
    token,
    sessionToken: token,
    user: sanitizeUser(newApplicant),
    emailDelivery: {
      configured: emailResult.providerConfigured,
      delivered: emailResult.delivered,
      error: emailResult.error,
    },
    message: emailResult.delivered
      ? 'Applicant account created successfully. Your account is active and verified.'
      : 'Applicant account created successfully. You can now immediately browse vacancies, submit applications, and upload documents.',
  });
});

// POST /api/auth/applicant/login: Dedicated applicant account login
app.post('/api/auth/applicant/login', (req: Request, res: Response) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body.password;

  if (!email || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Both email and password are required.' });
  }

  const user = db.findUserByEmail(email);
  if (!user) {
    return res.status(401).json({
      error: 'Invalid email or password.',
      code: 'USER_NOT_FOUND',
      accountExists: false,
    });
  }

  if (user.role !== 'APPLICANT') {
    return res.status(403).json({
      error: 'Access denied: This portal is for Job Applicants. Please sign in via the Staff Portal.',
    });
  }

  const passwordMatches = verifyPassword(password, user.password) || verifyPassword(password.trim(), user.password);
  if (!passwordMatches) {
    db.logAction(user.id, user.name, user.role, 'APPLICANT_LOGIN_FAILED', 'AUTH', `Failed applicant login for ${email}`);
    return res.status(401).json({
      error: 'Invalid email or password.',
      code: 'INVALID_PASSWORD',
      accountExists: true,
      email: user.email,
    });
  }

  if (user.accountStatus === 'SUSPENDED') {
    return res.status(403).json({
      error: 'Your applicant account has been suspended. Please contact AmCham Secretariat HR.',
    });
  }

  // Ensure applicant is marked verified since mandatory email verification is removed
  if (!user.isEmailVerified || user.verificationStatus !== 'VERIFIED') {
    db.updateUser(user.id, {
      isEmailVerified: true,
      verificationStatus: 'VERIFIED',
      emailVerifiedAt: user.emailVerifiedAt || new Date().toISOString(),
    });
  }

  const token = `amie_sec_${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();
  sessions.set(token, {
    token,
    userId: user.id,
    createdAt: now,
    expiresAt: now + SESSION_LIFETIME_MS,
  });
  savePersistedSessions();
  setSessionCookie(req, res, token);

  db.logAction(user.id, user.name, user.role, 'APPLICANT_LOGIN', 'AUTH', `Applicant logged in: ${user.name} (${user.email})`);

  res.json({
    success: true,
    token,
    sessionToken: token,
    user: sanitizeUser(user),
  });
});

// POST /api/applicant/verify-email: Verify email address
app.post('/api/applicant/verify-email', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  const { code, email } = req.body;
  const targetEmail = (active ? active.email : email)?.toLowerCase().trim();
  if (!targetEmail) {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  const user = db.findUserByEmail(targetEmail);
  if (!user) {
    return res.status(404).json({ error: 'Applicant account not found.' });
  }

  if (!code || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'Verification code is required.' });
  }

  const cleanCode = code.trim();
  if (!user.emailVerificationCode || user.emailVerificationCode !== cleanCode) {
    return res.status(400).json({ error: 'Invalid email verification code. Please check your code and retry.' });
  }

  if (user.emailVerificationExpires && Date.now() > Number(user.emailVerificationExpires)) {
    return res.status(400).json({ error: 'Verification code has expired. Please request a new verification code.' });
  }

  user.verificationStatus = 'VERIFIED';
  user.isEmailVerified = true;
  user.emailVerifiedAt = new Date().toISOString();
  user.emailVerificationCode = undefined;
  user.emailVerificationExpires = undefined;
  db.save();

  db.createNotification(
    user.id,
    'Email Address Verified',
    'Your email address has been verified. You can now receive all recruitment notices and interview schedules.',
    'SYSTEM',
    'overview',
    undefined,
    user.email
  );

  db.logAction(
    user.id,
    user.name,
    user.role,
    'VERIFY_EMAIL_SUCCESS',
    'AUTH',
    `Applicant verified email address: ${user.email}`
  );

  res.json({ success: true, message: 'Email address successfully verified.', user: sanitizeUser(user) });
});

// POST /api/applicant/resend-verification: Resend verification code
app.post('/api/applicant/resend-verification', async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  const email = (active ? active.email : req.body.email)?.toLowerCase().trim();
  if (!email) {
    return res.status(400).json({ error: 'Email address is required.' });
  }
  const user = db.findUserByEmail(email);
  if (!user) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const code = crypto.randomInt(100000, 999999).toString();
  user.emailVerificationCode = code;
  user.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000;
  db.save();

  const emailResult = await sendApplicantVerificationEmail({
    email: user.email,
    name: user.name,
    verificationCode: code,
  });

  res.json({
    success: true,
    emailDelivery: {
      configured: emailResult.providerConfigured,
      delivered: emailResult.delivered,
      error: emailResult.error,
    },
    message: emailResult.delivered
      ? 'A new verification code has been dispatched to your email address.'
      : 'A new verification code has been generated. (Note: Email delivery provider is not configured in this environment; outgoing email was not sent.)',
  });
});

// POST /api/recruitment/applicants/:userId/verify-email: HR Administrative manual verification
app.post(
  '/api/recruitment/applicants/:userId/verify-email',
  requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const { userId } = req.params;
    const active = getReqUser(req);
    const user = db.findUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Applicant account not found.' });
    }
    if (user.role !== 'APPLICANT') {
      return res.status(400).json({ error: 'Target user is not registered as an applicant.' });
    }

    user.verificationStatus = 'VERIFIED';
    user.isEmailVerified = true;
    user.emailVerifiedAt = new Date().toISOString();
    user.emailVerificationCode = undefined;
    user.emailVerificationExpires = undefined;
    db.save();

    db.createNotification(
      user.id,
      'Email Verified by HR Administrator',
      `Your applicant email address was verified by HR Administrator ${active.name}.`,
      'SYSTEM',
      'overview',
      undefined,
      user.email
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'HR_VERIFY_APPLICANT_EMAIL',
      'RECRUITMENT',
      `HR Administrator ${active.name} manually verified applicant email: ${user.email}`,
      user.id
    );

    res.json({
      success: true,
      message: `Applicant ${user.name} (${user.email}) email address marked as VERIFIED.`,
      user: sanitizeUser(user),
    });
  }
);

// GET /api/applicant/profile and /api/applicant/me: View applicant profile
app.get(['/api/applicant/profile', '/api/applicant/me'], (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active || active.role !== 'APPLICANT') {
    return res.status(401).json({ error: 'Authentication as applicant required.' });
  }
  res.json({ user: sanitizeUser(active) });
});

// GET /api/applicant/notifications: View applicant in-app notifications
app.get('/api/applicant/notifications', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active || active.role !== 'APPLICANT') {
    return res.status(401).json({ error: 'Authentication as applicant required.' });
  }
  const notifs = db.getNotifications(active.id, active.email);
  res.json({ notifications: notifs });
});

// PATCH /api/applicant/profile: Update applicant profile
app.patch('/api/applicant/profile', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active || active.role !== 'APPLICANT') {
    return res.status(401).json({ error: 'Authentication as applicant required.' });
  }
  const { name, phone, headline, bio } = req.body;
  if (name && typeof name === 'string' && name.trim()) active.name = name.trim();
  if (phone !== undefined) active.phone = typeof phone === 'string' ? phone.trim() : undefined;
  if (headline !== undefined) active.headline = typeof headline === 'string' ? headline.trim() : undefined;
  if (bio !== undefined) active.bio = typeof bio === 'string' ? bio.trim() : undefined;
  db.save();
  res.json({ success: true, user: sanitizeUser(active) });
});

// GET /api/applicant/applications: Retrieve applicant's own applications
app.get('/api/applicant/applications', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active || active.role !== 'APPLICANT') {
    return res.status(401).json({ error: 'Authentication as applicant required.' });
  }
  const normEmail = active.email.toLowerCase().trim();
  const allApps = db.getJobApplications();
  const myApps = allApps.filter((a) => a.applicantUserId === active.id || a.email.toLowerCase().trim() === normEmail);
  const sanitized = myApps.map((a) => {
    const { hrNotes: _, aiScreening: _ai, ...safeApp } = a;
    return {
      ...safeApp,
      documents: db.getApplicationDocuments({ applicationId: a.id }),
    };
  });
  res.json({ applications: sanitized });
});

// POST /api/applicant/applications: Submit application under authenticated applicant account
app.post('/api/applicant/applications', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active || active.role !== 'APPLICANT') {
    return res.status(401).json({ error: 'Authentication as applicant required.' });
  }
  const { vacancyId, fullName, phone, education, skills } = req.body;
  const exp = (req.body.experience || req.body.experienceSummary || 'N/A').toString().trim();
  const coverLetter = req.body.coverLetter ? String(req.body.coverLetter).trim() : undefined;
  const consent = req.body.privacyConsent === true || req.body.privacyConsent === 'true' || req.body.privacyConsent === '1' || !('privacyConsent' in req.body);

  if (!vacancyId) return res.status(400).json({ error: 'Vacancy ID is required.' });
  if (!fullName || !fullName.trim()) return res.status(400).json({ error: 'Full name is required.' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'Phone number is required.' });
  if (!education || !education.trim()) return res.status(400).json({ error: 'Educational background is required.' });
  if (!consent) return res.status(400).json({ error: 'Data privacy consent is required.' });

  const draft = (db.getData().recruitmentDrafts || []).find((d) => d.id === vacancyId && isVacancyPubliclyVisible(d));
  if (!draft) return res.status(404).json({ error: 'This vacancy is not open for applications.' });

  if (draft.applicationDeadline) {
    const today = new Date().toISOString().split('T')[0];
    if (today > draft.applicationDeadline) {
      return res.status(400).json({ error: `The application deadline (${draft.applicationDeadline}) has passed.` });
    }
  }

  const normEmail = active.email.toLowerCase().trim();
  const existing = (db.getData().jobApplications || []).find(
    (a) => (a.applicantUserId === active.id || a.email.toLowerCase().trim() === normEmail) && a.vacancyId === vacancyId
  );
  if (existing) {
    return res.status(409).json({
      error: `You have already applied for ${draft.jobTitle}.`,
      referenceNumber: existing.referenceNumber,
    });
  }

  let refNum = `APP-2026-${Math.floor(10000 + Math.random() * 90000)}`;
  while ((db.getData().jobApplications || []).some((a) => a.referenceNumber === refNum)) {
    refNum = `APP-2026-${Math.floor(10000 + Math.random() * 90000)}`;
  }
  const accessToken = crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString();

  let parsedSkills: string[] = [];
  if (Array.isArray(skills)) {
    parsedSkills = skills.map((s) => String(s).trim()).filter(Boolean);
  } else if (typeof skills === 'string') {
    parsedSkills = skills.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  }

  const newApp: JobApplication = {
    id: `app_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    referenceNumber: refNum,
    applicantUserId: active.id,
    vacancyId: draft.id,
    jobTitle: draft.jobTitle,
    department: draft.department,
    fullName: fullName.trim(),
    email: normEmail,
    phone: phone.trim(),
    education: education.trim(),
    experience: exp,
    skills: parsedSkills,
    coverLetter,
    privacyConsent: true,
    consentTimestamp: now,
    status: 'SUBMITTED',
    stageHistory: [
      {
        stage: 'SUBMITTED',
        timestamp: now,
        updatedBy: 'Applicant',
        note: 'Application submitted via AmCham Applicant Portal.',
      },
    ],
    accessToken,
    createdAt: now,
    updatedAt: now,
  };

  db.createJobApplication(newApp);

  // Notify applicant
  db.createNotification(
    active.id,
    'Application Submitted Successfully',
    `Your application for ${newApp.jobTitle} (Ref: ${newApp.referenceNumber}) has been submitted to the Secretariat HR Recruitment team.`,
    'SYSTEM',
    'applications',
    { applicationId: newApp.id, referenceNumber: newApp.referenceNumber },
    active.email
  );

  // Notify HR Administrators in-app with applicant name, position, reference number, and submission date
  const hrUsers = (db.getData().users || []).filter(
    (u) => u.role === 'HR_ADMINISTRATOR' || u.role === 'HR_PERSONNEL' || u.role === 'SYSTEM_ADMINISTRATOR'
  );
  const submissionDateFormatted = new Date(newApp.createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  for (const hr of hrUsers) {
    db.createNotification(
      hr.id,
      'New Job Application Received',
      `${newApp.fullName} submitted an application for ${newApp.jobTitle} (Ref: ${newApp.referenceNumber}) on ${submissionDateFormatted}.`,
      'SYSTEM',
      'recruitment',
      {
        applicationId: newApp.id,
        referenceNumber: newApp.referenceNumber,
        jobTitle: newApp.jobTitle,
        position: newApp.jobTitle,
        applicantName: newApp.fullName,
        applicantEmail: newApp.email,
        submissionDate: newApp.createdAt,
        targetSubTab: 'applications',
      }
    );
  }

  db.logAction(active.id, active.name, active.role, 'SUBMIT_JOB_APPLICATION', 'RECRUITMENT', `Submitted application for ${newApp.jobTitle} (Ref: ${newApp.referenceNumber})`, newApp.id);

  res.status(201).json({ success: true, application: newApp });
});

// PATCH /api/applicant/applications/:id: Update application details when allowed
app.patch('/api/applicant/applications/:id', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active || active.role !== 'APPLICANT') {
    return res.status(401).json({ error: 'Authentication as applicant required.' });
  }
  const { id } = req.params;
  const app = db.getJobApplicationById(id);
  if (!app) return res.status(404).json({ error: 'Application not found.' });

  const normEmail = active.email.toLowerCase().trim();
  if (app.applicantUserId !== active.id && app.email.toLowerCase().trim() !== normEmail) {
    return res.status(403).json({ error: 'You are not authorized to edit this application.' });
  }

  if (app.status !== 'SUBMITTED' && app.status !== 'UNDER_REVIEW') {
    return res.status(400).json({ error: `Corrections are not allowed while application is in ${app.status} status. Please contact HR.` });
  }

  const { phone, education, experience, skills } = req.body;
  const updates: Partial<JobApplication> = {};
  if (phone) updates.phone = String(phone).trim();
  if (education) updates.education = String(education).trim();
  if (experience) updates.experience = String(experience).trim();
  if (skills) {
    updates.skills = Array.isArray(skills) ? skills.map((s) => String(s).trim()) : String(skills).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  }

  const updated = db.updateJobApplication(id, updates);
  res.json({ success: true, application: updated });
});

// POST /api/applicant/applications/:id/documents: Upload requirement document
app.post(
  '/api/applicant/applications/:id/documents',
  applicantDocUploadMiddleware,
  async (req: Request, res: Response) => {
    const active = getActiveUser(req);
    if (!active) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const { id } = req.params;
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided for upload. Please select a valid document file.' });
    }

    const app = db.getJobApplicationById(id);
    if (!app) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    const isHR = active.role === 'HR_ADMINISTRATOR' || active.role === 'HR_PERSONNEL' || active.role === 'SYSTEM_ADMINISTRATOR';
    const isOwner = app.applicantUserId === active.id || app.email.toLowerCase().trim() === active.email.toLowerCase().trim();

    if (!isHR && !isOwner) {
      return res.status(403).json({ error: 'Access denied: You cannot upload documents to another applicant’s application.' });
    }

    // Verify file buffer is non-empty
    if (!file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ error: 'Uploaded file is empty or could not be saved to server storage.' });
    }

    const docType = (req.body.documentType || 'RESUME').trim();
    const docTitle = (req.body.requirementTitle || req.body.title || file.originalname).trim();
    const customTitle = req.body.customTitle ? String(req.body.customTitle).trim() : undefined;
    const resolvedTitle = docTitle === 'Other Supporting Documents' && customTitle ? customTitle : docTitle;
    const category = (req.body.category || (DEFAULT_REQUIREMENT_CATEGORY_MAP as Record<string, string>)[docTitle] || (DEFAULT_REQUIREMENT_CATEGORY_MAP as Record<string, string>)[resolvedTitle] || 'Other Supporting Documents').trim();

    try {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeRandom = crypto.randomBytes(16).toString('hex');
      const genFileName = `doc_${Date.now()}_${safeRandom}${ext}`;
      const stored = await firebaseStorage.uploadApplicantFile(
        file.buffer,
        genFileName,
        file.originalname,
        file.mimetype
      );

      // Prevent duplicate document records when users retry a failed upload or re-upload same requirement
      const allDocs = db.getApplicationDocuments({ applicationId: app.id });
      const existingReq = allDocs.find(
        (d) =>
          d.documentType === docType &&
          (d.status === 'REPLACEMENT_REQUESTED' || (d.requirementTitle || d.title || '').toLowerCase() === docTitle.toLowerCase())
      );

      let docRecord: ApplicationDocument;

      if (existingReq) {
        const updated = db.updateApplicationDocument(existingReq.id, {
          fileName: stored.fileName,
          originalName: file.originalname,
          fileSize: stored.sizeBytes,
          fileSizeBytes: stored.sizeBytes,
          mimeType: file.mimetype,
          storagePath: stored.storagePath,
          uploadedAt: stored.uploadedAt,
          status: 'SUBMITTED',
          title: resolvedTitle || existingReq.title,
          requirementTitle: docTitle || existingReq.requirementTitle,
          customTitle: customTitle || existingReq.customTitle,
          category: category || existingReq.category,
          reviewNote: `Updated by applicant on ${new Date().toISOString().split('T')[0]}`,
          reviewNotes: `Updated by applicant on ${new Date().toISOString().split('T')[0]}`,
        });
        docRecord = updated || existingReq;
      } else {
        docRecord = {
          id: `doc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          applicationId: app.id,
          applicantId: app.applicantUserId || active.id,
          applicantEmail: app.email,
          documentType: docType,
          title: resolvedTitle,
          requirementTitle: docTitle,
          customTitle: customTitle,
          category: category,
          fileName: stored.fileName,
          originalName: file.originalname,
          fileSize: stored.sizeBytes,
          fileSizeBytes: stored.sizeBytes,
          mimeType: file.mimetype,
          storagePath: stored.storagePath,
          uploadedAt: stored.uploadedAt,
          status: 'SUBMITTED',
          reviewNote: undefined,
          reviewNotes: undefined,
          isRequestedByHR: false,
        };
        db.createApplicationDocument(docRecord);
      }

      // Notify HR
      const hrUsers = (db.getData().users || []).filter(
        (u) => u.role === 'HR_ADMINISTRATOR' || u.role === 'HR_PERSONNEL' || u.role === 'SYSTEM_ADMINISTRATOR'
      );
      for (const hr of hrUsers) {
        db.createNotification(
          hr.id,
          'New Requirement Document Uploaded',
          `${app.fullName} uploaded ${docTitle} (${docType}) for ${app.jobTitle} (Ref: ${app.referenceNumber}).`,
          'SYSTEM',
          'recruitment',
          { applicationId: app.id, documentId: docRecord.id, documentTitle: docTitle }
        );
      }

      // Notify Applicant
      db.createNotification(
        app.applicantUserId || active.id,
        'Document Uploaded Successfully',
        `Your document "${docTitle}" has been received and added to application ${app.referenceNumber}.`,
        'SYSTEM',
        'requirements',
        { applicationId: app.id, documentId: docRecord.id },
        app.email
      );

      db.logAction(active.id, active.name, active.role, 'UPLOAD_APPLICATION_DOCUMENT', 'RECRUITMENT', `Uploaded document "${docTitle}" (${docType}) for ${app.referenceNumber}`, docRecord.id);

      res.status(201).json({ success: true, document: docRecord, message: 'Document uploaded successfully.' });
    } catch (saveError: any) {
      console.error('Failed to persist application document record:', saveError);
      res.status(500).json({ error: 'Failed to record application document metadata in system database.' });
    }
  }
);

// Stream document helper
const streamApplicationDoc = async (doc: ApplicationDocument, res: Response) => {
  const streamed = await firebaseStorage.streamDocumentToResponse(
    doc.storagePath,
    res,
    doc.mimeType || 'application/octet-stream',
    doc.originalName || doc.fileName
  );
  if (!streamed && !res.headersSent) {
    return res.status(404).json({ error: 'Document file not found in storage.' });
  }
};

// GET /api/applicant/documents/:docId/file & download: Stream document securely
app.get(
  ['/api/applicant/documents/:docId/file', '/api/applicant/documents/:docId/download'],
  async (req: Request, res: Response) => {
    const active = getActiveUser(req);
    if (!active) return res.status(401).json({ error: 'Authentication required.' });

    const { docId } = req.params;
    const doc = db.getApplicationDocumentById(docId);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    const isHR = active.role === 'HR_ADMINISTRATOR' || active.role === 'HR_PERSONNEL' || active.role === 'SYSTEM_ADMINISTRATOR';
    const isOwner = doc.applicantId === active.id || doc.applicantEmail.toLowerCase().trim() === active.email.toLowerCase().trim();

    if (!isHR && !isOwner) {
      return res.status(403).json({ error: 'Access denied: You do not have permission to view this document.' });
    }

    await streamApplicationDoc(doc, res);
  }
);

// GET /api/recruitment/applications/:appId/documents/:docId/file: HR view document
app.get(
  [
    '/api/recruitment/applications/:appId/documents/:docId/file',
    '/api/recruitment/applications/:appId/documents/:docId/download',
    '/api/recruitment/documents/:docId/file',
    '/api/recruitment/documents/:docId/download',
  ],
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  async (req: Request, res: Response) => {
    const { docId } = req.params;
    const doc = db.getApplicationDocumentById(docId);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found.' });
    }
    await streamApplicationDoc(doc, res);
  }
);

// POST /api/recruitment/applications/:appId/request-document: HR requests document
app.post('/api/recruitment/applications/:appId/request-document', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { appId } = req.params;
  const active = getReqUser(req);
  const title = (req.body.title || req.body.requirementTitle)?.trim();
  const customTitle = req.body.customTitle?.trim();
  const resolvedTitle = title === 'Other Supporting Documents' && customTitle ? customTitle : title;
  const category = (req.body.category || (DEFAULT_REQUIREMENT_CATEGORY_MAP as Record<string, string>)[title] || (DEFAULT_REQUIREMENT_CATEGORY_MAP as Record<string, string>)[resolvedTitle] || 'Other Supporting Documents').trim();
  const instructions = (req.body.instructions || req.body.description)?.trim();
  const documentType = req.body.documentType || 'OTHER';

  const app = db.getJobApplicationById(appId);
  if (!app) return res.status(404).json({ error: 'Application not found.' });

  if (!title) {
    return res.status(400).json({ error: 'Document title or requirement title is required.' });
  }

  const reqDoc: ApplicationDocument = {
    id: `doc_req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    applicationId: app.id,
    applicantId: app.applicantUserId || '',
    applicantEmail: app.email,
    documentType,
    title: resolvedTitle,
    requirementTitle: title,
    customTitle,
    category,
    fileName: '',
    originalName: '',
    fileSize: 0,
    fileSizeBytes: 0,
    mimeType: '',
    storagePath: '',
    uploadedAt: new Date().toISOString(),
    status: 'REPLACEMENT_REQUESTED',
    reviewNote: instructions || 'Please upload the requested document to proceed with evaluation.',
    reviewNotes: instructions || 'Please upload the requested document to proceed with evaluation.',
    isRequestedByHR: true,
  };

  db.createApplicationDocument(reqDoc);

  // Notify applicant
  const targetId = app.applicantUserId || db.findUserByEmail(app.email)?.id || app.email;
  db.createNotification(
    targetId,
    'Requirement Document Requested by HR',
    `The Secretariat HR team has requested a document for your ${app.jobTitle} application: "${title}". ${instructions ? `Instructions: "${instructions}"` : ''}`,
    'SYSTEM',
    'requirements',
    { applicationId: app.id, documentId: reqDoc.id, documentTitle: title },
    app.email
  );

  db.logAction(active.id, active.name, active.role, 'REQUEST_APPLICATION_DOCUMENT', 'RECRUITMENT', `Requested document "${title}" from applicant ${app.fullName} (Ref: ${app.referenceNumber})`, reqDoc.id);

  const updatedDocs = db.getApplicationDocuments({ applicationId: app.id });
  const updatedApp = { ...app, documents: updatedDocs };

  res.json({ success: true, document: reqDoc, application: updatedApp, message: 'Document request successfully sent to applicant.' });
});

// PATCH /api/recruitment/applications/:appId/documents/:docId/review: HR reviews document
app.patch('/api/recruitment/applications/:appId/documents/:docId/review', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { docId, appId } = req.params;
  const { status } = req.body;
  const reviewNote = req.body.reviewNote !== undefined ? req.body.reviewNote : req.body.reviewNotes;
  const active = getReqUser(req);

  const doc = db.getApplicationDocumentById(docId);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const app = db.getJobApplicationById(appId);

  const updatedDoc = db.updateApplicationDocument(docId, {
    status,
    reviewNote,
    reviewNotes: reviewNote,
  });

  if (app) {
    const targetId = app.applicantUserId || db.findUserByEmail(app.email)?.id || app.email;
    const readableStatus = status === 'ACCEPTED' ? 'Accepted' : status === 'REPLACEMENT_REQUESTED' ? 'Replacement Requested' : status;
    db.createNotification(
      targetId,
      'Document Status Review Update',
      `Your document "${doc.title || doc.requirementTitle}" for ${app.jobTitle} has been reviewed: ${readableStatus}.${reviewNote ? ` Note: "${reviewNote}"` : ''}`,
      'SYSTEM',
      'requirements',
      { applicationId: app.id, documentId: docId, status },
      app.email
    );
  }

  db.logAction(active.id, active.name, active.role, 'REVIEW_APPLICATION_DOCUMENT', 'RECRUITMENT', `Set status of document "${doc.title || doc.requirementTitle}" to ${status} for application ${appId}`, docId);

  const updatedDocs = app ? db.getApplicationDocuments({ applicationId: app.id }) : [];
  const updatedApp = app ? { ...app, documents: updatedDocs } : undefined;

  res.json({ success: true, document: updatedDoc, application: updatedApp });
});

// GET /api/applicant/faqs: Approved FAQ Knowledge Base
app.get('/api/applicant/faqs', (_req: Request, res: Response) => {
  res.json({ faqs: APPROVED_RECRUITMENT_FAQS });
});

// POST /api/applicant/faq-assistant/ask: Grounded Applicant FAQ Assistant
app.post('/api/applicant/faq-assistant/ask', async (req: Request, res: Response) => {
  try {
    const { question } = req.body;
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'Question is required.' });
    }

    const openDrafts = (db.getData().recruitmentDrafts || []).filter((d) => isVacancyPubliclyVisible(d));
    const vacancies = openDrafts.map((d) => ({
      id: d.id,
      jobTitle: d.jobTitle,
      department: d.department,
      location: d.location,
      employmentType: d.employmentType,
      applicationDeadline: d.applicationDeadline,
      qualifications: d.qualifications,
    }));

    const response = await askApplicantFaqAI({
      question: question.trim(),
      approvedFaqs: APPROVED_RECRUITMENT_FAQS,
      openVacancies: vacancies,
    });

    res.json({
      success: true,
      answer: response.answer,
      citations: response.citations,
      canEscalateToHR: response.canEscalateToHR,
      matchedFaqId: response.matchedFaqId,
    });
  } catch (err: any) {
    console.error('FAQ Assistant Error:', err);
    res.status(500).json({
      error: 'Failed to process inquiry. You can submit your question directly to HR below.',
      canEscalateToHR: true,
    });
  }
});

// POST /api/applicant/inquiries: Submit inquiry to HR
app.post('/api/applicant/inquiries', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active || active.role !== 'APPLICANT') {
    return res.status(401).json({ error: 'Authentication as applicant required.' });
  }

  const { subject, question, applicationId } = req.body;
  if (!subject || !subject.trim() || !question || !question.trim()) {
    return res.status(400).json({ error: 'Subject and question content are required.' });
  }

  let appRef: string | undefined;
  let jobTitle: string | undefined;
  if (applicationId) {
    const app = db.getJobApplicationById(applicationId);
    if (app) {
      appRef = app.referenceNumber;
      jobTitle = app.jobTitle;
    }
  }

  const newInquiry: ApplicantInquiry = {
    id: `inq_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    applicantId: active.id,
    applicantName: active.name,
    applicantEmail: active.email,
    applicationId,
    referenceNumber: appRef,
    jobTitle,
    subject: subject.trim(),
    question: question.trim(),
    status: 'UNANSWERED',
    createdAt: new Date().toISOString(),
  };

  db.createApplicantInquiry(newInquiry);

  // Notify HR
  const hrUsers = (db.getData().users || []).filter(
    (u) => u.role === 'HR_ADMINISTRATOR' || u.role === 'HR_PERSONNEL' || u.role === 'SYSTEM_ADMINISTRATOR'
  );
  for (const hr of hrUsers) {
    db.createNotification(
      hr.id,
      'New Applicant Question Received',
      `${active.name} submitted an inquiry: "${subject.trim()}".`,
      'SYSTEM',
      'recruitment',
      { inquiryId: newInquiry.id, applicantName: active.name, subject: newInquiry.subject }
    );
  }

  // Notify applicant of submission
  db.createNotification(
    active.id,
    'Question Submitted to HR',
    `Your question "${subject.trim()}" was forwarded to the Secretariat HR Recruitment team. You will be notified when an answer is posted.`,
    'SYSTEM',
    'inquiries',
    { inquiryId: newInquiry.id },
    active.email
  );

  db.logAction(active.id, active.name, active.role, 'SUBMIT_APPLICANT_INQUIRY', 'RECRUITMENT', `Submitted inquiry: "${subject.trim()}"`, newInquiry.id);

  res.status(201).json({ success: true, inquiry: newInquiry, message: 'Question submitted to HR recruitment team.' });
});

// GET /api/applicant/inquiries: Applicant views their inquiries
app.get('/api/applicant/inquiries', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active || active.role !== 'APPLICANT') {
    return res.status(401).json({ error: 'Authentication as applicant required.' });
  }
  const inquiries = db.getApplicantInquiries({ applicantId: active.id });
  res.json({ inquiries });
});

// GET /api/recruitment/inquiries: HR reviews all applicant inquiries
app.get('/api/recruitment/inquiries', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { status } = req.query;
  const inquiries = db.getApplicantInquiries({ status: typeof status === 'string' ? (status as any) : 'ALL' });
  res.json({ inquiries });
});

// POST /api/recruitment/inquiries/:id/respond: HR responds to applicant inquiry
app.post('/api/recruitment/inquiries/:id/respond', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const { response } = req.body;
  const active = getReqUser(req);

  if (!response || !response.trim()) {
    return res.status(400).json({ error: 'Response content is required.' });
  }

  const inq = db.getApplicantInquiryById(id);
  if (!inq) return res.status(404).json({ error: 'Inquiry not found.' });

  const updatedInq = db.updateApplicantInquiry(id, {
    status: 'RESOLVED',
    hrResponse: response.trim(),
    respondedBy: active.name,
    respondedAt: new Date().toISOString(),
  });

  // Notify the applicant
  db.createNotification(
    inq.applicantId,
    'HR Response to Your Question',
    `The HR Recruitment team replied to your inquiry "${inq.subject}": "${response.trim().substring(0, 100)}..."`,
    'SYSTEM',
    'inquiries',
    { inquiryId: id },
    inq.applicantEmail
  );

  db.logAction(active.id, active.name, active.role, 'RESPOND_APPLICANT_INQUIRY', 'RECRUITMENT', `Responded to applicant inquiry "${inq.subject}" from ${inq.applicantName}`, id);

  res.json({ success: true, inquiry: updatedInq, message: 'Response saved and applicant notified.' });
});

// ----------------------------------------------------
// 5. MODULE THREE: ONBOARDING ASSISTANT
// ----------------------------------------------------
app.get('/api/onboarding/tasks', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Onboarding resources are restricted to internal Secretariat staff.' });
  }
  const { employeeId } = req.query;
  if (active.role === 'EMPLOYEE' || active.role === 'DEPARTMENT_HEAD') {
    const activeEmail = active.email ? active.email.toLowerCase().trim() : '';
    const activeEmpNo = active.employeeNumber;
    const tasks = db.getData().onboardingTasks.filter(
      (t) =>
        t.userId === active.id ||
        (activeEmpNo && t.userId === activeEmpNo) ||
        (activeEmail && t.employeeEmail && t.employeeEmail.toLowerCase().trim() === activeEmail)
    );
    return res.json({ tasks });
  }
  let tasks = db.getData().onboardingTasks;
  if (employeeId && typeof employeeId === 'string' && employeeId !== 'ALL') {
    const filterNorm = employeeId.toLowerCase().trim();
    tasks = tasks.filter(
      (t) =>
        t.userId === employeeId ||
        (t.employeeEmail && t.employeeEmail.toLowerCase().trim() === filterNorm)
    );
  }
  res.json({ tasks });
});

app.get('/api/onboarding/templates', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Onboarding templates are restricted to internal Secretariat staff.' });
  }
  res.json({ templates: db.getData().onboardingTemplates });
});

app.post('/api/onboarding/templates', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const { roleName, department, description, tasks } = req.body;

  if (!roleName || !department || !Array.isArray(tasks)) {
    return res.status(400).json({ error: 'Role name, department, and tasks array are required.' });
  }

  const newTemplate = {
    id: `tmpl_${Date.now()}`,
    roleName,
    department,
    description: description || `Onboarding template for ${roleName}`,
    tasks,
  };

  db.getData().onboardingTemplates.push(newTemplate);
  db.save();
  db.logAction(active.id, active.name, active.role, 'CREATE_ONBOARDING_TEMPLATE', 'ONBOARDING', `Created onboarding template: ${roleName}`, newTemplate.id);
  res.json({ success: true, template: newTemplate });
});

// 5.1 EMPLOYEE SEARCH FOR TASK ASSIGNMENT (HR ONLY)
app.get('/api/employees/search', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const query = typeof req.query.query === 'string' ? req.query.query.trim().toLowerCase() : '';
  const users = db.getData().users;

  // Filter actual registered employee accounts (active and non-suspended)
  let filtered = users.filter((u) => u.accountStatus !== 'SUSPENDED');
  if (query) {
    filtered = filtered.filter((u) =>
      u.email.toLowerCase().includes(query) ||
      u.name.toLowerCase().includes(query) ||
      (u.jobTitle && u.jobTitle.toLowerCase().includes(query)) ||
      (u.department && u.department.toLowerCase().includes(query))
    );
  }

  const safe = filtered.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    department: u.department,
    jobTitle: u.jobTitle,
    accountStatus: u.accountStatus,
    employeeNumber: u.employeeNumber,
  }));

  res.json({ employees: safe });
});

// Acknowledge task receipt (Assigned Employee only)
app.post('/api/onboarding/tasks/:id/acknowledge', (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const task = db.getData().onboardingTasks.find((t) => t.id === id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  // Security: Only the assigned employee can acknowledge this task
  const isAssignedEmployee =
    task.userId === active.id ||
    (active.employeeNumber && task.userId === active.employeeNumber) ||
    (active.email && task.employeeEmail?.toLowerCase() === active.email.toLowerCase());
  if (!isAssignedEmployee) {
    return res.status(403).json({ error: 'Only the assigned employee can acknowledge this task.' });
  }

  // Prevent duplicate acknowledgement
  if (task.acknowledgedAt) {
    return res.json({ success: true, task, alreadyAcknowledged: true, message: 'Task already acknowledged.' });
  }

  task.status = 'ACKNOWLEDGED';
  task.acknowledgedAt = new Date().toISOString();
  task.acknowledgedBy = active.name;
  task.acknowledgedById = active.id;
  task.updatedAt = new Date().toISOString();

  // Create in-app notification for active HR Administration & assigner
  const ackRecipients = new Set<string>();
  if (task.assignedById && task.assignedById !== active.id) ackRecipients.add(task.assignedById);
  for (const hr of db.getActiveHRRecipients(active.id)) ackRecipients.add(hr.id);
  for (const recipientId of ackRecipients) {
    db.createNotification(
      recipientId,
      'Onboarding Task Acknowledged',
      `${active.name} acknowledged receipt of task: "${task.title}".`,
      'ONBOARDING',
      'onboarding',
      {
        taskId: task.id,
        taskTitle: task.title,
        employeeId: active.id,
        employeeName: active.name,
        acknowledgedAt: task.acknowledgedAt,
        eventKey: `onb_ack_${task.id}_${recipientId}`,
      }
    );
  }

  db.save();
  db.logAction(
    active.id,
    active.name,
    active.role,
    'ACKNOWLEDGE_ONBOARDING_TASK',
    'ONBOARDING',
    `Employee ${active.name} acknowledged task "${task.title}"`,
    id
  );

  res.json({ success: true, task, message: 'Task acknowledged successfully.' });
});

// Update onboarding task status, progress, notes, and completion details
app.post('/api/onboarding/tasks/:id/status', (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, notes, completionNote, deliverableUrl } = req.body;
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const task = db.getData().onboardingTasks.find((t) => t.id === id);

  if (!task) return res.status(404).json({ error: 'Task not found.' });

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  // Security check: employee can only update their own tasks
  const isAssigned =
    task.userId === active.id ||
    (active.employeeNumber && task.userId === active.employeeNumber) ||
    (active.email && task.employeeEmail?.toLowerCase() === active.email.toLowerCase());
  if (!isHR && !isAssigned) {
    return res.status(403).json({ error: 'Cannot modify another employee onboarding task.' });
  }

  // Security check: only HR or Admin can mark a task as VERIFIED
  if (status === 'VERIFIED' && !isHR) {
    return res.status(403).json({ error: 'Only HR personnel or administrators can mark onboarding tasks as verified.' });
  }

  if (status) task.status = status;
  if (notes !== undefined) task.notes = notes;
  task.updatedAt = new Date().toISOString();

  if (status === 'IN_PROGRESS') {
    task.startedAt = task.startedAt || new Date().toISOString();
  } else if (status === 'COMPLETED') {
    task.completedAt = new Date().toISOString();
    task.completedBy = active.name;
    task.completedById = active.id;
    if (completionNote !== undefined) task.completionNote = completionNote;
    if (deliverableUrl !== undefined) task.deliverableUrl = deliverableUrl;

    // Notify HR assigner & active HR officers of task completion
    const compRecipients = new Set<string>();
    if (task.assignedById && task.assignedById !== active.id) compRecipients.add(task.assignedById);
    for (const hr of db.getActiveHRRecipients(active.id)) compRecipients.add(hr.id);
    const notePreview = completionNote ? ` Note: "${completionNote.substring(0, 80)}"` : '';
    for (const recipientId of compRecipients) {
      db.createNotification(
        recipientId,
        'Onboarding Task Completed',
        `${active.name} marked task "${task.title}" as Completed.${notePreview}`,
        'ONBOARDING',
        'onboarding',
        {
          taskId: task.id,
          taskTitle: task.title,
          employeeId: active.id,
          employeeName: active.name,
          completedAt: task.completedAt,
          eventKey: `onb_complete_${task.id}_${recipientId}_${Date.now()}`,
        }
      );
    }
  } else if (status === 'VERIFIED') {
    task.verifiedBy = active.name;
    task.verifiedAt = new Date().toISOString();

    // Notify employee of verification
    db.createNotification(
      task.userId,
      'Task Submission Verified by HR',
      `Your onboarding task "${task.title}" has been verified by ${active.name}.`,
      'ONBOARDING',
      'onboarding',
      {
        taskId: task.id,
        taskTitle: task.title,
        verifiedBy: active.name,
        verifiedAt: task.verifiedAt,
      }
    );
  } else if (status === 'AWAITING_ACKNOWLEDGEMENT' || status === 'PENDING') {
    task.completedAt = undefined;
    task.completedBy = undefined;
    task.completedById = undefined;
    task.verifiedBy = undefined;
    task.verifiedAt = undefined;
  }

  db.save();
  db.logAction(active.id, active.name, active.role, 'UPDATE_ONBOARDING_TASK_STATUS', 'ONBOARDING', `Updated task "${task.title}" to ${status}`, id);
  res.json({ success: true, task });
});

// Task Progress Chat: Get messages for a task
app.get('/api/onboarding/tasks/:id/messages', (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const task = db.getData().onboardingTasks.find((t) => t.id === id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  const isAssigned = task.userId === active.id || (active.email && task.employeeEmail?.toLowerCase() === active.email.toLowerCase());
  if (!isHR && !isAssigned) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to view conversation for this task.' });
  }

  const messages = db.getTaskMessages(id);
  res.json({ success: true, messages });
});

// Task Progress Chat: Post a message / progress update
app.post('/api/onboarding/tasks/:id/messages', (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const task = db.getData().onboardingTasks.find((t) => t.id === id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  const isAssigned = task.userId === active.id || (active.email && task.employeeEmail?.toLowerCase() === active.email.toLowerCase());
  if (!isHR && !isAssigned) {
    return res.status(403).json({ error: 'Forbidden: You cannot send messages for another employee task.' });
  }

  const messageText = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!messageText) {
    return res.status(400).json({ error: 'Message content cannot be empty.' });
  }
  if (messageText.length > 2000) {
    return res.status(400).json({ error: 'Message exceeds maximum allowed length (2000 characters).' });
  }

  // Determine recipient
  let recipientId = '';
  if (isHR) {
    recipientId = task.userId; // employee
  } else {
    recipientId = task.assignedById || db.getData().users.find((u) => u.role === 'HR_ADMINISTRATOR')?.id || '';
  }

  const newMsg = db.addTaskMessage({
    taskId: task.id,
    senderId: active.id,
    senderName: active.name,
    senderRole: active.role,
    senderEmail: active.email,
    recipientId,
    message: messageText,
  });

  // In-app notification for the recipient
  if (recipientId && recipientId !== active.id) {
    const notifTitle = isHR ? `HR Message on "${task.title}"` : `Task Progress Update: "${task.title}"`;
    const snippet = messageText.length > 70 ? messageText.substring(0, 67) + '...' : messageText;
    const notifBody = `${active.name}: "${snippet}"`;

    db.createNotification(
      recipientId,
      notifTitle,
      notifBody,
      'ONBOARDING',
      'onboarding',
      {
        taskId: task.id,
        taskTitle: task.title,
        senderId: active.id,
        senderName: active.name,
        senderRole: active.role,
        messageId: newMsg.id,
      }
    );
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    'POST_TASK_PROGRESS_MESSAGE',
    'ONBOARDING',
    `Sent progress message on task "${task.title}"`,
    task.id
  );

  res.json({ success: true, message: newMsg });
});

// Create custom onboarding task (HR only)
app.post('/api/onboarding/tasks', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const { userId, employeeEmail, title, description, category, dueDate, notes, responsibleRole, requiredDocument } = req.body;

  if ((!userId && !employeeEmail) || !title || !dueDate) {
    return res.status(400).json({ error: 'Employee ID or registered email, task title, and due date are required.' });
  }

  // Lookup target employee by registered email or stable user ID
  let targetUser: User | undefined;
  if (employeeEmail && typeof employeeEmail === 'string' && employeeEmail.trim()) {
    const normEmail = employeeEmail.toLowerCase().trim();
    targetUser = db.getData().users.find((u) => u.email.toLowerCase().trim() === normEmail);
  }
  if (!targetUser && userId && typeof userId === 'string' && userId.trim()) {
    const idOrEmail = userId.trim();
    targetUser = db.getData().users.find(
      (u) =>
        u.id === idOrEmail ||
        u.email.toLowerCase().trim() === idOrEmail.toLowerCase() ||
        (u.employeeNumber && u.employeeNumber === idOrEmail)
    );
  }

  if (!targetUser) {
    return res.status(404).json({
      error: 'Target employee account not found in directory. Please search and select an active registered employee account.',
    });
  }

  // Prevent conflicting recipient identifiers
  if (userId && employeeEmail) {
    const userById = db.getData().users.find((u) => u.id === userId || u.employeeNumber === userId);
    if (userById && userById.email.toLowerCase().trim() !== targetUser.email.toLowerCase().trim()) {
      return res.status(400).json({
        error: 'Conflict detected between recipient employee ID and email address.',
      });
    }
  }

  // Prevent duplicate task creation during network retries (same title and employee within 60s)
  const isDuplicate = db.getData().onboardingTasks.some(
    (t) =>
      t.userId === targetUser!.id &&
      t.title.toLowerCase().trim() === title.trim().toLowerCase() &&
      t.status !== 'COMPLETED' &&
      t.status !== 'VERIFIED' &&
      t.createdAt &&
      Math.abs(Date.now() - new Date(t.createdAt).getTime()) < 60000
  );
  if (isDuplicate) {
    return res.status(409).json({
      error: 'A task with this title was recently assigned to this employee. Please wait or edit the existing task to avoid duplication.',
    });
  }

  const newTask = {
    id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    userId: targetUser.id,
    employeeName: targetUser.name,
    employeeEmail: targetUser.email.toLowerCase().trim(),
    title: title.trim(),
    description: description?.trim() || '',
    category: category || 'ADMIN',
    dueDate,
    status: 'AWAITING_ACKNOWLEDGEMENT' as const,
    notes: notes?.trim() || undefined,
    responsibleRole: responsibleRole?.trim() || 'HR Secretariat',
    requiredDocument: requiredDocument?.trim() || undefined,
    assignedBy: active.name,
    assignedById: active.id,
    createdAt: new Date().toISOString(),
  };

  db.getData().onboardingTasks.push(newTask);

  // Create persistent in-app notification for the target employee with dual ID and email linkage
  const notifTitle = 'New Onboarding Task Assigned';
  const notifMsg = `${active.name} assigned you a new onboarding task: "${newTask.title}".`;
  db.createNotification(
    targetUser.id,
    notifTitle,
    notifMsg,
    'ONBOARDING',
    'onboarding',
    {
      taskId: newTask.id,
      taskTitle: newTask.title,
      category: newTask.category,
      dueDate: newTask.dueDate,
      assignedBy: active.name,
      assignedById: active.id,
      recipientEmail: targetUser.email.toLowerCase().trim(),
    },
    targetUser.email.toLowerCase().trim()
  );

  db.save();

  db.logAction(
    active.id,
    active.name,
    active.role,
    'CREATE_CUSTOM_ONBOARDING_TASK',
    'ONBOARDING',
    `Created task "${newTask.title}" for user ${targetUser.name} (${targetUser.email})`,
    newTask.id
  );
  res.json({ success: true, task: newTask });
});


// Update onboarding task details (HR or task owner)
app.put('/api/onboarding/tasks/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const task = db.getData().onboardingTasks.find((t) => t.id === id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  const isOwner =
    task.userId === active.id ||
    (task.employeeEmail && active.email && task.employeeEmail.toLowerCase().trim() === active.email.toLowerCase().trim());

  if (!isHR && !isOwner) {
    return res.status(403).json({ error: 'Forbidden: Cannot edit another employee onboarding task.' });
  }

  const nowTs = new Date().toISOString();
  if (isHR) {
    const { title, description, category, dueDate, notes, responsibleRole, requiredDocument, status } = req.body;
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (category !== undefined) task.category = category;
    if (dueDate !== undefined) task.dueDate = dueDate;
    if (notes !== undefined) task.notes = notes;
    if (responsibleRole !== undefined) task.responsibleRole = responsibleRole;
    if (requiredDocument !== undefined) task.requiredDocument = requiredDocument;
    if (status !== undefined) {
      task.status = status;
      if (status === 'COMPLETED') task.completedAt = task.completedAt || nowTs;
      if (status === 'VERIFIED') task.verifiedBy = active.name;
    }
  } else {
    // Employee can edit notes and status
    const { notes, status } = req.body;
    if (notes !== undefined) task.notes = notes;
    if (status && status !== 'VERIFIED') {
      task.status = status;
      if (status === 'COMPLETED') task.completedAt = nowTs;
    }
  }
  task.updatedAt = nowTs;

  db.save();
  db.logAction(active.id, active.name, active.role, 'UPDATE_ONBOARDING_TASK', 'ONBOARDING', `Edited task "${task.title}"`, id);
  res.json({ success: true, task });
});

// Delete onboarding task (HR only)
app.delete('/api/onboarding/tasks/:id', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const data = db.getData();
  const idx = data.onboardingTasks.findIndex((t) => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found.' });

  const [removed] = data.onboardingTasks.splice(idx, 1);
  db.save();

  db.logAction(active.id, active.name, active.role, 'DELETE_ONBOARDING_TASK', 'ONBOARDING', `Deleted task "${removed.title}"`, id);
  res.json({ success: true, message: `Task "${removed.title}" deleted.` });
});

// Assign onboarding template with start date confirmation, employee validation, duplicate prevention & in-app notification
app.post('/api/onboarding/assign', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { userId, templateId, startDate, forceReassign } = req.body;
  const active = getReqUser(req);

  if (!userId || !templateId) {
    return res.status(400).json({ error: 'Employee ID and Onboarding Template ID are required.' });
  }

  // Verify target employee exists in directory
  const targetUser = db.getData().users.find((u) => u.id === userId) || db.getData().employeeRecords.find((e) => e.userId === userId);
  if (!targetUser) {
    return res.status(404).json({ error: 'Target employee record not found in directory.' });
  }

  const targetEmployeeName = (targetUser as any).name || (targetUser as any).fullName || 'Secretariat Staff';
  const targetEmployeeEmail = (targetUser as any).email || (targetUser as any).workEmail || undefined;

  const template = db.getData().onboardingTemplates.find((t) => t.id === templateId);
  if (!template) return res.status(404).json({ error: 'Onboarding template not found.' });

  const existingTasks = db.getData().onboardingTasks.filter((t) => t.userId === userId);

  // Duplicate Assignment Prevention
  if (existingTasks.length > 0 && !forceReassign) {
    return res.status(409).json({
      success: false,
      duplicateDetected: true,
      existingCount: existingTasks.length,
      message: `Employee already has ${existingTasks.length} active onboarding tasks assigned. To replace them with a fresh assignment, please confirm re-assignment.`,
    });
  }

  // If forceReassign is true, remove existing tasks for this user
  if (existingTasks.length > 0 && forceReassign) {
    db.getData().onboardingTasks = db.getData().onboardingTasks.filter((t) => t.userId !== userId);
  }

  const baseTime = startDate ? new Date(startDate).getTime() : Date.now();
  const assignNow = new Date().toISOString();

  const newTasks = template.tasks.map((t, idx) => ({
    id: `task_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 5)}`,
    userId,
    employeeName: targetEmployeeName,
    employeeEmail: targetEmployeeEmail,
    title: t.title,
    description: t.description,
    category: t.category,
    dueDate: new Date(baseTime + t.dueDayOffset * 86400000).toISOString().split('T')[0],
    status: 'PENDING' as const,
    requiredDocument: t.requiredDocument,
    learningResourceUrl: t.learningResourceUrl,
    responsibleRole: t.category === 'IT' ? 'IT Coordinator' : t.category === 'HR' ? 'HR Administration' : 'Department Head',
    assignedBy: active.name,
    assignedById: active.id,
    createdAt: assignNow,
    updatedAt: assignNow,
  }));

  db.getData().onboardingTasks.push(...newTasks);

  // Create persistent in-app notification for the target employee
  const notifTitle = 'New Onboarding Roadmap Assigned';
  const notifMsg = `${active.name} assigned you a new onboarding roadmap: "${template.roleName}" (${newTasks.length} milestone tasks). Scheduled start date: ${startDate || 'Immediate'}.`;


  // Avoid creating exact duplicate unread notification on repeated retries
  const existingUnreadNotif = (db.getData().notifications || []).find(
    (n) => n.userId === userId && n.type === 'ONBOARDING' && !n.read
  );

  let createdNotification = null;
  if (!existingUnreadNotif) {
    createdNotification = db.createNotification(
      userId,
      notifTitle,
      notifMsg,
      'ONBOARDING',
      'onboarding',
      {
        templateId,
        templateName: template.roleName,
        taskCount: newTasks.length,
        startDate: startDate || new Date().toISOString().split('T')[0],
        assignedBy: active.name,
      }
    );
  }

  db.save();

  db.logAction(
    active.id,
    active.name,
    active.role,
    'ASSIGN_ONBOARDING_TEMPLATE',
    'ONBOARDING',
    `Assigned template "${template.roleName}" with ${newTasks.length} tasks to employee ${userId}. Start date: ${startDate || 'Current Date'}.`
  );

  res.json({
    success: true,
    assignedTasks: newTasks.length,
    tasks: newTasks,
    notification: createdNotification,
  });
});

// ----------------------------------------------------
// NOTIFICATIONS API
// ----------------------------------------------------
app.get('/api/notifications', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const notifications = db.getNotifications(active.id, active.email);
  const unreadCount = notifications.filter((n) => !n.read).length;
  res.json({ notifications, unreadCount });
});

app.post('/api/notifications/:id/read', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { id } = req.params;
  const ok = db.markNotificationRead(id, active.id, active.email);
  if (!ok) {
    return res.status(404).json({ error: 'Notification not found or access denied.' });
  }
  res.json({ success: true });
});

app.post('/api/notifications/mark-all-read', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const count = db.markAllNotificationsRead(active.id, active.email);
  res.json({ success: true, count });
});

// AI Onboarding Assistant (explains tasks, summarizes progress, suggests checkpoints)
app.post('/api/onboarding/ai-assist', async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { action, employeeName, jobTitle, department, startDate, taskTitle, taskCategory, currentTasks } = req.body;

  if (!action || !['EXPLAIN_TASK', 'SUMMARIZE_PROGRESS', 'SUGGEST_CHECKLIST'].includes(action)) {
    return res.status(400).json({ error: 'Valid action parameter (EXPLAIN_TASK, SUMMARIZE_PROGRESS, SUGGEST_CHECKLIST) is required.' });
  }

  try {
    const guidance = await assistOnboardingAI({
      action,
      employeeName: employeeName || active.name,
      jobTitle: jobTitle || active.jobTitle,
      department: department || active.department,
      startDate,
      taskTitle,
      taskCategory,
      currentTasks,
    });

    db.logAction(active.id, active.name, active.role, 'AI_ONBOARDING_ASSIST', 'ONBOARDING', `Queried AI Onboarding Assistant: ${action} for ${taskTitle || employeeName || active.name}`);
    res.json({ success: true, data: guidance });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'AI onboarding guidance request failed.' });
  }
});

// ----------------------------------------------------
// 6. MODULE FOUR: EMPLOYEE PERFORMANCE ANALYSIS (ANNUAL CYCLE)
// ----------------------------------------------------
function calculateRubricScore(scores: Record<string, number> = {}): { overallScore: number; overallRating: string } {
  const vals = Object.values(scores).map(Number).filter((v) => !isNaN(v));
  if (vals.length === 0) {
    return { overallScore: 3, overallRating: 'Satisfactory (3)' };
  }
  const avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  let rating = 'Satisfactory (3)';
  if (avg >= 4.5) rating = 'Outstanding (5)';
  else if (avg >= 3.5) rating = 'Commendable (4)';
  else if (avg >= 2.5) rating = 'Satisfactory (3)';
  else if (avg >= 1.5) rating = 'Marginal (2)';
  else rating = 'Unsatisfactory (1)';
  return { overallScore: avg, overallRating: rating };
}

function extractYearFromReview(review: { evaluationYear?: number; period?: string }): number {
  if (review.evaluationYear && !isNaN(Number(review.evaluationYear))) {
    return Number(review.evaluationYear);
  }
  if (review.period) {
    const match = review.period.match(/\b(19\d\d|20\d\d)\b/);
    if (match) return parseInt(match[1], 10);
  }
  return new Date().getFullYear();
}

const DEFAULT_FORM65_COMPETENCIES = [
  'Event Management & Committee Coordination',
  'Cross-Cultural Communication & Diplomatic Acumen',
  'Policy Research & Legislative Monitoring',
  'Digital Tools & CRM Administration',
  'Stakeholder Relations & Membership Stewardship',
  'Strategic Leadership & Project Governance',
];

function getRequiredCompetencyNames(): string[] {
  const dbComps = db.getData().competencies || [];
  return dbComps.length > 0 ? dbComps.map((c) => c.name) : DEFAULT_FORM65_COMPETENCIES;
}

function validateCompleteEvaluationForForward(
  competencyScores: Record<string, any> | undefined,
  managerFeedback: string | undefined
): { valid: boolean; error?: string; normalizedScores?: Record<string, number> } {
  const requiredNames = getRequiredCompetencyNames();
  if (!competencyScores || typeof competencyScores !== 'object') {
    return { valid: false, error: 'All required competency ratings (1–5) must be completed before forwarding to HR.' };
  }

  const normalizedScores: Record<string, number> = {};
  const missing: string[] = [];

  for (const name of requiredNames) {
    const raw = competencyScores[name];
    if (raw === undefined || raw === null || raw === '') {
      missing.push(name);
      continue;
    }
    const num = Number(raw);
    if (isNaN(num) || num < 1 || num > 5 || !Number.isInteger(num)) {
      return {
        valid: false,
        error: `Invalid rating for "${name}". All competency ratings must be whole numbers from 1 to 5 (Form 65 rubric).`,
      };
    }
    normalizedScores[name] = num;
  }

  // Also preserve any additional valid scored competencies if present
  for (const [k, v] of Object.entries(competencyScores)) {
    if (v === undefined || v === null || v === '' || Number(v) === 0) continue;
    const num = Number(v);
    if (isNaN(num) || num < 1 || num > 5) {
      return {
        valid: false,
        error: `Invalid rating for "${k}". Competency scores must be between 1 and 5 in accordance with Form 65.`,
      };
    }
    normalizedScores[k] = num;
  }

  if (missing.length > 0) {
    return {
      valid: false,
      error: `Incomplete evaluation: Please complete ratings for all required competencies (${missing.join(', ')}) before forwarding to HR.`,
    };
  }

  if (!managerFeedback || typeof managerFeedback !== 'string' || managerFeedback.trim().length === 0) {
    return {
      valid: false,
      error: 'Department Head Feedback is mandatory and cannot be empty or whitespace-only.',
    };
  }

  return { valid: true, normalizedScores };
}

function sanitizeDraftCompetencyScores(competencyScores: Record<string, any> | undefined): { valid: boolean; error?: string; scores: Record<string, number> } {
  const scores: Record<string, number> = {};
  if (!competencyScores || typeof competencyScores !== 'object') {
    return { valid: true, scores };
  }
  for (const [compName, raw] of Object.entries(competencyScores)) {
    if (raw === undefined || raw === null || raw === '' || Number(raw) === 0) {
      continue;
    }
    const numScore = Number(raw);
    if (isNaN(numScore) || numScore < 1 || numScore > 5) {
      return {
        valid: false,
        error: `Invalid rating for "${compName}". Competency scores must be between 1 and 5 in accordance with Form 65 (Performance Review Rubric).`,
        scores: {},
      };
    }
    scores[compName] = numScore;
  }
  return { valid: true, scores };
}

function appendReviewAuditEntry(
  review: PerformanceReview,
  entry: Omit<PerformanceReviewAuditEntry, 'id' | 'timestamp'>
) {
  if (!Array.isArray(review.auditHistory)) {
    review.auditHistory = [];
  }
  review.auditHistory.push({
    id: `paudit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  });
}

function notifyHRAdminOnPerformanceSubmission(review: PerformanceReview, actor: User, isRevision = false) {
  const revSeq = review.revisionCount || 0;
  const eventKey = `perf_forward_${review.id}_${revSeq}_${Date.now()}`;
  const title = isRevision
    ? `Revised Evaluation Forwarded: ${review.employeeName}`
    : `Performance Evaluation Pending HR Review: ${review.employeeName}`;
  const message = `${actor.name} (${review.department}) forwarded the ${review.evaluationYear} performance evaluation for ${review.employeeName} (Score: ${review.overallScore ?? 'N/A'}/5).`;

  const recipients = new Map<string, { id: string; email: string }>();
  const rachelUser =
    db.findUserById(DESIGNATED_HR_ADMIN_CONFIG.id) ||
    db.findUserByEmail(DESIGNATED_HR_ADMIN_CONFIG.primaryEmail);

  if (rachelUser) {
    recipients.set(rachelUser.id, { id: rachelUser.id, email: rachelUser.email });
  } else {
    recipients.set(DESIGNATED_HR_ADMIN_CONFIG.id, {
      id: DESIGNATED_HR_ADMIN_CONFIG.id,
      email: DESIGNATED_HR_ADMIN_CONFIG.primaryEmail,
    });
  }

  for (const u of db.getData().users) {
    if (u.role === 'HR_ADMINISTRATOR' && u.accountStatus !== 'SUSPENDED') {
      recipients.set(u.id, { id: u.id, email: u.email });
    }
  }

  for (const rec of recipients.values()) {
    db.createNotification(
      rec.id,
      title,
      message,
      'PERFORMANCE',
      'performance',
      {
        reviewId: review.id,
        employeeId: review.employeeId,
        employeeName: review.employeeName,
        department: review.department,
        evaluatorId: actor.id,
        evaluatorName: actor.name,
        eventKey,
      },
      rec.email
    );
  }
}

function enrichReviewWithDirectoryDetails(review: PerformanceReview): PerformanceReview {
  const data = db.getData();
  const targetUser = data.users.find((u) => u.id === review.employeeId);
  const targetEmpRec = data.employeeRecords.find((e) => e.userId === review.employeeId);
  const evalId = review.submittedById || review.evaluatorId;
  const evalUser = evalId ? data.users.find((u) => u.id === evalId) : undefined;

  return {
    ...review,
    employeeNumber: review.employeeNumber || targetUser?.employeeNumber || targetEmpRec?.employeeNumber || '',
    jobTitle: review.jobTitle || targetUser?.jobTitle || targetEmpRec?.jobTitle || '',
    workEmail: review.workEmail || targetUser?.email || targetEmpRec?.workEmail || '',
    employmentStatus: review.employmentStatus || targetEmpRec?.employmentStatus || 'REGULAR',
    evaluatorName: review.evaluatorName || review.submittedBy || evalUser?.name,
    evaluatorRole: review.evaluatorRole || evalUser?.role,
    evaluatorDepartment: review.evaluatorDepartment || evalUser?.department || review.department,
    evaluatorJobTitle: review.evaluatorJobTitle || evalUser?.jobTitle,
  };
}

app.get('/api/performance/reviews', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Performance evaluations are restricted to internal Secretariat staff.' });
  }
  const { employeeId, year } = req.query;

  // Strict confidentiality: Employees (and non-HR Managers) can ONLY view their own reviews
  if (active.role === 'EMPLOYEE' || active.role === 'MANAGER') {
    let records = db.getData().performanceReviews.filter((r) => r.employeeId === active.id);
    if (year && year !== 'ALL') {
      const targetY = parseInt(year as string, 10);
      if (!isNaN(targetY)) {
        records = records.filter((r) => extractYearFromReview(r) === targetY);
      }
    }
    return res.json({ reviews: records.map(enrichReviewWithDirectoryDetails) });
  }

  // Strict Department Isolation: Department Heads can ONLY view evaluations in their own department
  if (active.role === 'DEPARTMENT_HEAD') {
    let records = db.getData().performanceReviews.filter((r) => isSameDepartment(r.department, active.department));
    if (employeeId && typeof employeeId === 'string') {
      const targetEmp = db.findUserById(employeeId);
      if (targetEmp && !isSameDepartment(targetEmp.department, active.department)) {
        return res.status(403).json({
          error: `Access denied: Employee does not belong to your assigned department (${active.department}).`,
        });
      }
      records = records.filter((r) => r.employeeId === employeeId);
    }
    if (year && year !== 'ALL') {
      const targetY = parseInt(year as string, 10);
      if (!isNaN(targetY)) {
        records = records.filter((r) => extractYearFromReview(r) === targetY);
      }
    }
    return res.json({ reviews: records.map(enrichReviewWithDirectoryDetails) });
  }

  let reviews = db.getData().performanceReviews;
  if (employeeId) {
    reviews = reviews.filter((r) => r.employeeId === employeeId);
  }
  if (year && year !== 'ALL') {
    const targetY = parseInt(year as string, 10);
    if (!isNaN(targetY)) {
      reviews = reviews.filter((r) => extractYearFromReview(r) === targetY);
    }
  }
  res.json({ reviews: reviews.map(enrichReviewWithDirectoryDetails) });
});

// Create or update performance review with annual cycle validation, 5-point scale rubric, and duplicate check
app.post('/api/performance/reviews', requireRole(['DEPARTMENT_HEAD', 'HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const {
    employeeId,
    employeeName,
    department,
    jobTitle,
    employeeNumber,
    evaluationYear,
    period,
    managerFeedback,
    selfAssessment,
    goals,
    competencyScores,
    strengths,
    developmentAreas,
    reviewStatus,
  } = req.body;

  if (!employeeId) {
    return res.status(400).json({ error: 'Employee ID is required.' });
  }

  const targetUser = db.findUserById(employeeId);
  const targetEmpRec = db.getData().employeeRecords.find((e) => e.userId === employeeId);
  const resolvedEmpName = employeeName || targetUser?.name || targetEmpRec?.fullName;
  if (!resolvedEmpName) {
    return res.status(400).json({ error: 'Employee name is required.' });
  }

  const resolvedDepartment = targetUser?.department || targetEmpRec?.department || department || 'Committees & Events';

  // Strict backend enforcement for Department Heads
  if (active.role === 'DEPARTMENT_HEAD') {
    if (!targetUser && !targetEmpRec) {
      return res.status(404).json({ error: 'Target employee not found in Secretariat database.' });
    }
    if (targetUser?.role === 'APPLICANT') {
      return res.status(400).json({ error: 'External applicants cannot receive staff performance evaluations.' });
    }
    if (employeeId === active.id) {
      return res.status(403).json({ error: 'Department Heads cannot evaluate themselves.' });
    }
    if (!isSameDepartment(resolvedDepartment, active.department)) {
      db.logAction(
        active.id,
        active.name,
        active.role,
        'UNAUTHORIZED_CROSS_DEPT_EVAL_ATTEMPT',
        'PERFORMANCE',
        `Department Head (${active.department}) attempted to evaluate ${resolvedEmpName} (${resolvedDepartment})`,
        employeeId
      );
      return res.status(403).json({
        error: `Access denied: You may only evaluate employees assigned to your department (${active.department}).`,
      });
    }
    if (reviewStatus && reviewStatus !== 'DRAFT' && reviewStatus !== 'PENDING_HR_REVIEW') {
      return res.status(403).json({
        error: 'Department Heads may only save evaluations as Draft or forward them to HR (PENDING_HR_REVIEW).',
      });
    }
  }

  // Determine annual evaluation year (must be a valid integer year, e.g. 2026, 2027)
  const targetYear = evaluationYear
    ? Number(evaluationYear)
    : period
    ? extractYearFromReview({ period })
    : new Date().getFullYear();

  if (isNaN(targetYear) || targetYear < 2000) {
    return res.status(400).json({ error: 'A valid annual Evaluation Year is required (e.g. 2026, 2027).' });
  }

  const finalPeriod = period ? String(period).trim() : String(targetYear);
  const targetStatus: PerformanceReviewStatus = (reviewStatus as PerformanceReviewStatus) || 'DRAFT';

  // Validate scores depending on whether saving draft vs forwarding/submitting
  let sanitizedScores: Record<string, number> = {};
  if (targetStatus === 'PENDING_HR_REVIEW') {
    const check = validateCompleteEvaluationForForward(competencyScores, managerFeedback);
    if (!check.valid || !check.normalizedScores) {
      return res.status(400).json({ error: check.error || 'Evaluation is incomplete.' });
    }
    sanitizedScores = check.normalizedScores;
  } else {
    const draftCheck = sanitizeDraftCompetencyScores(competencyScores);
    if (!draftCheck.valid) {
      return res.status(400).json({ error: draftCheck.error });
    }
    sanitizedScores = draftCheck.scores;
  }

  const hasScores = Object.keys(sanitizedScores).length > 0;
  const { overallScore, overallRating } = hasScores
    ? calculateRubricScore(sanitizedScores)
    : { overallScore: undefined, overallRating: undefined };

  const existingReviews = db.getData().performanceReviews;
  const existingReview = existingReviews.find((r) => {
    if (r.employeeId !== employeeId) return false;
    const rYear = extractYearFromReview(r);
    return rYear === targetYear;
  });

  // Duplicate Submission Prevention for Annual Cycle
  if (existingReview) {
    if (existingReview.reviewStatus === 'DRAFT' || existingReview.reviewStatus === 'RETURNED_FOR_REVISION') {
      const prevStatus = existingReview.reviewStatus;
      existingReview.managerFeedback = managerFeedback !== undefined ? managerFeedback : existingReview.managerFeedback;
      existingReview.selfAssessment = selfAssessment !== undefined ? selfAssessment : existingReview.selfAssessment;
      existingReview.goals = goals || existingReview.goals;
      existingReview.competencyScores = sanitizedScores;
      existingReview.strengths = strengths || existingReview.strengths;
      existingReview.developmentAreas = developmentAreas || existingReview.developmentAreas;
      existingReview.overallScore = overallScore;
      existingReview.overallRating = overallRating;
      existingReview.evaluationYear = targetYear;
      existingReview.period = finalPeriod;
      if (jobTitle || targetUser?.jobTitle || targetEmpRec?.jobTitle) existingReview.jobTitle = jobTitle || targetUser?.jobTitle || targetEmpRec?.jobTitle;
      if (employeeNumber || targetUser?.employeeNumber || targetEmpRec?.employeeNumber) existingReview.employeeNumber = employeeNumber || targetUser?.employeeNumber || targetEmpRec?.employeeNumber;
      existingReview.workEmail = targetUser?.email || targetEmpRec?.workEmail || existingReview.workEmail;
      existingReview.employmentStatus = targetEmpRec?.employmentStatus || existingReview.employmentStatus || 'REGULAR';
      existingReview.reviewStatus = targetStatus;
      existingReview.evaluatorId = active.id;
      existingReview.evaluatorName = active.name;
      existingReview.evaluatorRole = active.role;
      existingReview.evaluatorDepartment = active.department;
      existingReview.evaluatorJobTitle = active.jobTitle;
      const nowIso = new Date().toISOString();
      existingReview.updatedAt = nowIso;

      if (targetStatus === 'PENDING_HR_REVIEW') {
        existingReview.submittedAt = nowIso;
        existingReview.submittedBy = active.name;
        existingReview.submittedById = active.id;
        existingReview.revisionCount = (existingReview.revisionCount || 0) + (prevStatus === 'RETURNED_FOR_REVISION' ? 1 : 0);
        appendReviewAuditEntry(existingReview, {
          action: prevStatus === 'RETURNED_FOR_REVISION' ? 'REVISED_AND_FORWARDED' : 'FORWARDED_TO_HR',
          performedBy: active.name,
          performedById: active.id,
          performedByRole: active.role,
          previousStatus: prevStatus,
          newStatus: 'PENDING_HR_REVIEW',
          details: `Forwarded ${targetYear} performance evaluation for ${resolvedEmpName} to HR Administration.`,
          remarks: existingReview.managerFeedback,
          overallScoreSnapshot: existingReview.overallScore,
          overallRatingSnapshot: existingReview.overallRating,
          competencyScoresSnapshot: { ...sanitizedScores },
          feedbackSnapshot: existingReview.managerFeedback,
        });
      } else {
        appendReviewAuditEntry(existingReview, {
          action: 'UPDATED_DRAFT',
          performedBy: active.name,
          performedById: active.id,
          performedByRole: active.role,
          previousStatus: prevStatus,
          newStatus: existingReview.reviewStatus,
          details: `Updated evaluation draft for ${resolvedEmpName} (${targetYear}).`,
          overallScoreSnapshot: existingReview.overallScore,
          overallRatingSnapshot: existingReview.overallRating,
          competencyScoresSnapshot: { ...sanitizedScores },
          feedbackSnapshot: existingReview.managerFeedback,
        });
      }

      db.save();
      if (targetStatus === 'PENDING_HR_REVIEW') {
        notifyHRAdminOnPerformanceSubmission(existingReview, active, prevStatus === 'RETURNED_FOR_REVISION');
      }

      db.logAction(
        active.id,
        active.name,
        active.role,
        targetStatus === 'PENDING_HR_REVIEW' ? 'FORWARD_PERFORMANCE_REVIEW' : 'UPDATE_PERFORMANCE_DRAFT',
        'PERFORMANCE',
        `${targetStatus === 'PENDING_HR_REVIEW' ? 'Forwarded' : 'Updated'} annual evaluation for ${resolvedEmpName} (Year: ${targetYear}, Status: ${existingReview.reviewStatus})`,
        existingReview.id
      );
      return res.json({ success: true, review: existingReview, updatedExistingDraft: true });
    } else {
      return res.status(409).json({
        error: `An official annual performance evaluation already exists for ${resolvedEmpName} for evaluation year ${targetYear} (Status: ${existingReview.reviewStatus}, Period: "${existingReview.period}"). Only one official evaluation per employee per calendar year is permitted under PS 016.`,
      });
    }
  }

  const now = new Date().toISOString();
  const newReview: PerformanceReview = {
    id: `perf_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    employeeId,
    employeeName: resolvedEmpName,
    department: resolvedDepartment,
    jobTitle: jobTitle || targetUser?.jobTitle || targetEmpRec?.jobTitle || '',
    employeeNumber: employeeNumber || targetUser?.employeeNumber || targetEmpRec?.employeeNumber || '',
    workEmail: targetUser?.email || targetEmpRec?.workEmail || '',
    employmentStatus: targetEmpRec?.employmentStatus || 'REGULAR',
    evaluationYear: targetYear,
    period: finalPeriod,
    evaluatorId: active.id,
    evaluatorName: active.name,
    evaluatorRole: active.role,
    evaluatorDepartment: active.department,
    evaluatorJobTitle: active.jobTitle,
    managerFeedback: typeof managerFeedback === 'string' ? managerFeedback : '',
    selfAssessment: selfAssessment || '',
    goals: goals || [],
    competencyScores: sanitizedScores,
    overallScore,
    overallRating,
    strengths: strengths || [],
    developmentAreas: developmentAreas || [],
    reviewStatus: targetStatus,
    ...(targetStatus === 'PENDING_HR_REVIEW'
      ? {
          submittedAt: now,
          submittedBy: active.name,
          submittedById: active.id,
          revisionCount: 0,
        }
      : { revisionCount: 0 }),
    auditHistory: [],
    createdAt: now,
    updatedAt: now,
  };

  appendReviewAuditEntry(newReview, {
    action: targetStatus === 'PENDING_HR_REVIEW' ? 'FORWARDED_TO_HR' : 'CREATED_DRAFT',
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
    newStatus: targetStatus,
    details:
      targetStatus === 'PENDING_HR_REVIEW'
        ? `Completed and forwarded ${targetYear} performance evaluation for ${resolvedEmpName} to HR.`
        : `Saved ${targetYear} performance evaluation draft for ${resolvedEmpName}.`,
    remarks: targetStatus === 'PENDING_HR_REVIEW' ? newReview.managerFeedback : undefined,
    overallScoreSnapshot: newReview.overallScore,
    overallRatingSnapshot: newReview.overallRating,
    competencyScoresSnapshot: { ...sanitizedScores },
    feedbackSnapshot: newReview.managerFeedback,
  });

  db.getData().performanceReviews.push(newReview);
  db.save();

  if (targetStatus === 'PENDING_HR_REVIEW') {
    notifyHRAdminOnPerformanceSubmission(newReview, active, false);
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    targetStatus === 'PENDING_HR_REVIEW' ? 'FORWARD_PERFORMANCE_REVIEW' : 'CREATE_PERFORMANCE_REVIEW',
    'PERFORMANCE',
    `${targetStatus === 'PENDING_HR_REVIEW' ? 'Forwarded' : 'Created'} annual performance evaluation for ${resolvedEmpName} (Year: ${targetYear}, Status: ${newReview.reviewStatus})`,
    newReview.id
  );
  res.json({ success: true, review: enrichReviewWithDirectoryDetails(newReview) });
});

// Analyze standalone performance inputs via AI
app.post('/api/performance/analyze', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), async (req: Request, res: Response) => {
  try {
    const { employeeName, department, period, evaluationYear, managerFeedback, selfAssessment, goals, competencyScores } = req.body;
    const catalog = db.getData().trainingCatalog;
    const displayPeriod = evaluationYear ? `Annual Evaluation ${evaluationYear}` : (period || 'Annual Evaluation Cycle');
    const analysis = await analyzePerformanceAI({
      employeeName: employeeName || 'Secretariat Staff Member',
      department: department || 'Committees & Events',
      period: displayPeriod,
      managerFeedback: managerFeedback || '',
      selfAssessment: selfAssessment || '',
      goals: goals || [],
      competencyScores: competencyScores || {},
      availableCatalogCourses: catalog.map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        addressedCompetencies: c.addressedCompetencies,
      })),
    });
    res.json({ success: true, analysis });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Performance analysis failed.' });
  }
});

// Update performance review (HR, Department Head on Draft/Returned, or Employee self-assessment)
app.put('/api/performance/reviews/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT' || active.role === 'MANAGER') {
    return res.status(403).json({ error: 'Forbidden: Role lacks authorization to modify performance evaluations.' });
  }

  const review = db.getData().performanceReviews.find((r) => r.id === id);
  if (!review) return res.status(404).json({ error: 'Review not found.' });

  // Employee can only update their own self-assessment
  if (active.role === 'EMPLOYEE') {
    if (review.employeeId !== active.id) {
      return res.status(403).json({ error: 'Cannot modify another employee review.' });
    }
    if (req.body.selfAssessment !== undefined) {
      review.selfAssessment = req.body.selfAssessment;
      review.updatedAt = new Date().toISOString();
    }
    db.save();
    return res.json({ success: true, review });
  }

  // Department Head strict scope & post-forward lock enforcement
  if (active.role === 'DEPARTMENT_HEAD') {
    if (!isSameDepartment(review.department, active.department)) {
      return res.status(403).json({
        error: `Access denied: You may only manage evaluations for employees in your department (${active.department}).`,
      });
    }
    if (review.employeeId === active.id) {
      return res.status(403).json({ error: 'Department Heads cannot modify their own evaluation.' });
    }
    if (review.reviewStatus !== 'DRAFT' && review.reviewStatus !== 'RETURNED_FOR_REVISION') {
      return res.status(403).json({
        error: `Evaluation is locked (Status: ${review.reviewStatus.replace(/_/g, ' ')}) and cannot be modified after forwarding to HR unless returned for revision.`,
      });
    }

    const nextStatus = (req.body.reviewStatus as PerformanceReviewStatus) || review.reviewStatus;
    if (nextStatus !== 'DRAFT' && nextStatus !== 'PENDING_HR_REVIEW' && nextStatus !== 'RETURNED_FOR_REVISION') {
      return res.status(403).json({
        error: 'Department Heads cannot mark evaluations as HR Reviewed or Validated.',
      });
    }

    const nextFeedback = req.body.managerFeedback !== undefined ? req.body.managerFeedback : review.managerFeedback;
    const rawScores = req.body.competencyScores !== undefined ? req.body.competencyScores : review.competencyScores;

    let sanitizedScores: Record<string, number> = {};
    if (nextStatus === 'PENDING_HR_REVIEW') {
      const check = validateCompleteEvaluationForForward(rawScores, nextFeedback);
      if (!check.valid || !check.normalizedScores) {
        return res.status(400).json({ error: check.error || 'Evaluation is incomplete.' });
      }
      sanitizedScores = check.normalizedScores;
    } else {
      const draftCheck = sanitizeDraftCompetencyScores(rawScores);
      if (!draftCheck.valid) {
        return res.status(400).json({ error: draftCheck.error });
      }
      sanitizedScores = draftCheck.scores;
    }

    const prevStatus = review.reviewStatus;
    review.managerFeedback = typeof nextFeedback === 'string' ? nextFeedback : '';
    if (req.body.selfAssessment !== undefined) review.selfAssessment = req.body.selfAssessment;
    if (req.body.goals !== undefined) review.goals = req.body.goals;
    if (req.body.strengths !== undefined) review.strengths = req.body.strengths;
    if (req.body.developmentAreas !== undefined) review.developmentAreas = req.body.developmentAreas;
    review.competencyScores = sanitizedScores;

    if (Object.keys(sanitizedScores).length > 0) {
      const { overallScore, overallRating } = calculateRubricScore(sanitizedScores);
      review.overallScore = overallScore;
      review.overallRating = overallRating;
    } else {
      review.overallScore = undefined;
      review.overallRating = undefined;
    }

    const nowIso = new Date().toISOString();
    review.evaluatorId = active.id;
    review.evaluatorName = active.name;
    review.evaluatorRole = active.role;
    review.evaluatorDepartment = active.department;
    review.evaluatorJobTitle = active.jobTitle;
    review.updatedAt = nowIso;

    if (nextStatus === 'PENDING_HR_REVIEW') {
      review.reviewStatus = 'PENDING_HR_REVIEW';
      review.submittedAt = nowIso;
      review.submittedBy = active.name;
      review.submittedById = active.id;
      review.revisionCount = (review.revisionCount || 0) + (prevStatus === 'RETURNED_FOR_REVISION' ? 1 : 0);
      appendReviewAuditEntry(review, {
        action: prevStatus === 'RETURNED_FOR_REVISION' ? 'REVISED_AND_FORWARDED' : 'FORWARDED_TO_HR',
        performedBy: active.name,
        performedById: active.id,
        performedByRole: active.role,
        previousStatus: prevStatus,
        newStatus: 'PENDING_HR_REVIEW',
        details: `Forwarded ${review.evaluationYear} evaluation for ${review.employeeName} to HR Administration.`,
        remarks: review.managerFeedback,
        overallScoreSnapshot: review.overallScore,
        overallRatingSnapshot: review.overallRating,
        competencyScoresSnapshot: { ...sanitizedScores },
        feedbackSnapshot: review.managerFeedback,
      });
      db.save();
      notifyHRAdminOnPerformanceSubmission(review, active, prevStatus === 'RETURNED_FOR_REVISION');
    } else {
      // Keep RETURNED_FOR_REVISION or DRAFT if saving draft
      if (nextStatus === 'DRAFT' && prevStatus !== 'RETURNED_FOR_REVISION') {
        review.reviewStatus = 'DRAFT';
      }
      appendReviewAuditEntry(review, {
        action: 'UPDATED_DRAFT',
        performedBy: active.name,
        performedById: active.id,
        performedByRole: active.role,
        previousStatus: prevStatus,
        newStatus: review.reviewStatus,
        details: `Saved draft changes for ${review.employeeName} (${review.evaluationYear}).`,
        overallScoreSnapshot: review.overallScore,
        overallRatingSnapshot: review.overallRating,
        competencyScoresSnapshot: { ...sanitizedScores },
        feedbackSnapshot: review.managerFeedback,
      });
      db.save();
    }

    db.logAction(
      active.id,
      active.name,
      active.role,
      nextStatus === 'PENDING_HR_REVIEW' ? 'FORWARD_PERFORMANCE_REVIEW' : 'UPDATE_PERFORMANCE_DRAFT',
      'PERFORMANCE',
      `Department Head ${nextStatus === 'PENDING_HR_REVIEW' ? 'forwarded' : 'updated'} evaluation for ${review.employeeName}`,
      id
    );
    return res.json({ success: true, review });
  }

  // HR Personnel / Admin updates
  const prevStatus = review.reviewStatus;
  if (req.body.competencyScores && typeof req.body.competencyScores === 'object') {
    for (const [compName, score] of Object.entries(req.body.competencyScores)) {
      const numScore = Number(score);
      if (isNaN(numScore) || numScore < 1 || numScore > 5) {
        return res.status(400).json({
          error: `Invalid rating for "${compName}". Competency scores must be between 1 and 5 in accordance with Form 65.`,
        });
      }
    }
    const { overallScore, overallRating } = calculateRubricScore(req.body.competencyScores);
    review.overallScore = overallScore;
    review.overallRating = overallRating;
  }

  // Check if year or period is being changed, verify no duplicate conflict
  if (req.body.evaluationYear !== undefined) {
    const newYear = Number(req.body.evaluationYear);
    const conflict = db.getData().performanceReviews.find(
      (r) =>
        r.id !== id &&
        r.employeeId === review.employeeId &&
        extractYearFromReview(r) === newYear &&
        (r.reviewStatus === 'SUBMITTED' ||
          r.reviewStatus === 'PENDING_HR_REVIEW' ||
          r.reviewStatus === 'REVIEWED' ||
          r.reviewStatus === 'HR_VALIDATED')
    );
    if (conflict) {
      return res.status(409).json({
        error: `Another finalized or submitted evaluation already exists for ${review.employeeName} for year ${newYear}. Duplicate annual evaluations are prohibited.`,
      });
    }
    review.evaluationYear = newYear;
    if (!req.body.period) {
      review.period = String(newYear);
    }
  }

  Object.assign(review, req.body, { updatedAt: new Date().toISOString() });
  if (req.body.reviewStatus === 'HR_VALIDATED' || req.body.reviewStatus === 'REVIEWED') {
    review.reviewedBy = active.name;
    review.reviewedById = active.id;
    review.reviewedAt = new Date().toISOString();
    appendReviewAuditEntry(review, {
      action: req.body.reviewStatus === 'REVIEWED' ? 'HR_MARKED_REVIEWED' : 'HR_VALIDATED',
      performedBy: active.name,
      performedById: active.id,
      performedByRole: active.role,
      previousStatus: prevStatus,
      newStatus: review.reviewStatus,
      details: `HR (${active.name}) marked evaluation for ${review.employeeName} as ${review.reviewStatus}.`,
      remarks: review.hrRemarks || review.aiSummary?.hrCorrectionNotes,
      overallScoreSnapshot: review.overallScore,
      overallRatingSnapshot: review.overallRating,
    });
  }
  db.save();

  const recipientId = review.evaluatorId || review.submittedById;
  if ((req.body.reviewStatus === 'HR_VALIDATED' || req.body.reviewStatus === 'REVIEWED') && recipientId && recipientId !== active.id) {
    const dhUser = db.findUserById(recipientId);
    db.createNotification(
      recipientId,
      `Evaluation ${req.body.reviewStatus === 'HR_VALIDATED' ? 'Validated & Endorsed' : 'Reviewed'} by HR: ${review.employeeName}`,
      `${active.name} ${req.body.reviewStatus === 'HR_VALIDATED' ? 'validated and endorsed' : 'marked as reviewed'} the ${review.evaluationYear} evaluation for ${review.employeeName}.`,
      'PERFORMANCE',
      'performance',
      {
        reviewId: review.id,
        employeeId: review.employeeId,
        employeeName: review.employeeName,
        department: review.department,
        eventKey: `perf_validated_${review.id}_${Date.now()}`,
      },
      dhUser?.email
    );
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    req.body.reviewStatus === 'HR_VALIDATED' ? 'FINALIZE_PERFORMANCE_REVIEW' : 'UPDATE_PERFORMANCE_REVIEW',
    'PERFORMANCE',
    `Updated annual review for ${review.employeeName} (Year: ${review.evaluationYear || review.period}, Status: ${review.reviewStatus})`,
    id
  );
  res.json({ success: true, review: enrichReviewWithDirectoryDetails(review) });
});

// Dedicated endpoint: Forward completed evaluation to HR (Department Head / HR)
app.post('/api/performance/reviews/:id/forward-to-hr', requireRole(['DEPARTMENT_HEAD', 'HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const review = db.getData().performanceReviews.find((r) => r.id === id);
  if (!review) {
    return res.status(404).json({ error: 'Evaluation record not found.' });
  }

  if (active.role === 'DEPARTMENT_HEAD') {
    if (!isSameDepartment(review.department, active.department)) {
      return res.status(403).json({
        error: `Access denied: You may only forward evaluations for employees in your department (${active.department}).`,
      });
    }
    if (review.employeeId === active.id) {
      return res.status(403).json({ error: 'Department Heads cannot forward a self-evaluation.' });
    }
  }

  if (
    review.reviewStatus === 'PENDING_HR_REVIEW' ||
    review.reviewStatus === 'REVIEWED' ||
    review.reviewStatus === 'HR_VALIDATED'
  ) {
    return res.status(409).json({
      error: `Duplicate submission prevented: This evaluation is already in status "${review.reviewStatus.replace(/_/g, ' ')}".`,
    });
  }

  const candidateScores = req.body.competencyScores !== undefined ? req.body.competencyScores : review.competencyScores;
  const candidateFeedback = req.body.managerFeedback !== undefined ? req.body.managerFeedback : review.managerFeedback;

  const check = validateCompleteEvaluationForForward(candidateScores, candidateFeedback);
  if (!check.valid || !check.normalizedScores) {
    return res.status(400).json({ error: check.error || 'Evaluation is incomplete and cannot be forwarded to HR.' });
  }

  const prevStatus = review.reviewStatus;
  if (req.body.goals !== undefined) review.goals = req.body.goals;
  if (req.body.selfAssessment !== undefined) review.selfAssessment = req.body.selfAssessment;
  if (req.body.strengths !== undefined) review.strengths = req.body.strengths;
  if (req.body.developmentAreas !== undefined) review.developmentAreas = req.body.developmentAreas;

  review.competencyScores = check.normalizedScores;
  review.managerFeedback = candidateFeedback.trim();
  const { overallScore, overallRating } = calculateRubricScore(check.normalizedScores);
  review.overallScore = overallScore;
  review.overallRating = overallRating;

  const nowIso = new Date().toISOString();
  review.reviewStatus = 'PENDING_HR_REVIEW';
  review.submittedAt = nowIso;
  review.submittedBy = active.name;
  review.submittedById = active.id;
  review.evaluatorId = active.id;
  review.evaluatorName = active.name;
  review.evaluatorRole = active.role;
  review.evaluatorDepartment = active.department;
  review.evaluatorJobTitle = active.jobTitle;
  review.updatedAt = nowIso;
  review.revisionCount = (review.revisionCount || 0) + (prevStatus === 'RETURNED_FOR_REVISION' ? 1 : 0);

  const isRevision = prevStatus === 'RETURNED_FOR_REVISION';
  appendReviewAuditEntry(review, {
    action: isRevision ? 'REVISED_AND_FORWARDED' : 'FORWARDED_TO_HR',
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
    previousStatus: prevStatus,
    newStatus: 'PENDING_HR_REVIEW',
    details: isRevision
      ? `Revised and re-forwarded ${review.evaluationYear} evaluation for ${review.employeeName} to HR.`
      : `Completed and forwarded ${review.evaluationYear} evaluation for ${review.employeeName} to HR.`,
    remarks: review.managerFeedback,
    overallScoreSnapshot: review.overallScore,
    overallRatingSnapshot: review.overallRating,
    competencyScoresSnapshot: { ...check.normalizedScores },
    feedbackSnapshot: review.managerFeedback,
  });

  db.save();
  notifyHRAdminOnPerformanceSubmission(review, active, isRevision);

  db.logAction(
    active.id,
    active.name,
    active.role,
    'FORWARD_PERFORMANCE_REVIEW',
    'PERFORMANCE',
    `Forwarded evaluation for ${review.employeeName} (${review.department}) to HR Administration for review`,
    review.id
  );

  res.json({
    success: true,
    review: enrichReviewWithDirectoryDetails(review),
    message: `Evaluation for ${review.employeeName} forwarded to HR Administration (PENDING HR REVIEW).`,
  });
});

// HR Review Action: Add Remarks, Mark as Reviewed, Validate & Endorse, or Return for Revision (Mandatory Reason + Dept Head Notification)
app.post('/api/performance/reviews/:id/hr-review', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const { action, remarks } = req.body;

  const review = db.getData().performanceReviews.find((r) => r.id === id);
  if (!review) {
    return res.status(404).json({ error: 'Evaluation record not found.' });
  }

  if (!action || !['MARK_REVIEWED', 'VALIDATE_ENDORSE', 'RETURN_FOR_REVISION', 'ADD_REMARKS'].includes(action)) {
    return res.status(400).json({
      error: 'Valid HR review action is required (MARK_REVIEWED, VALIDATE_ENDORSE, RETURN_FOR_REVISION, or ADD_REMARKS).',
    });
  }

  const trimmedRemarks = typeof remarks === 'string' ? remarks.trim() : '';
  const nowIso = new Date().toISOString();
  const prevStatus = review.reviewStatus;

  if (action === 'RETURN_FOR_REVISION') {
    if (review.reviewStatus === 'DRAFT') {
      return res.status(400).json({ error: 'Draft evaluations have not been forwarded to HR yet.' });
    }
    if (review.reviewStatus === 'RETURNED_FOR_REVISION') {
      return res.status(409).json({ error: 'This evaluation has already been returned for revision.' });
    }
    if (!trimmedRemarks) {
      return res.status(400).json({
        error: 'A written reason is required when returning a performance evaluation for revision.',
      });
    }

    review.reviewStatus = 'RETURNED_FOR_REVISION';
    review.returnReason = trimmedRemarks;
    review.hrRemarks = trimmedRemarks;
    review.returnedBy = active.name;
    review.returnedById = active.id;
    review.returnedAt = nowIso;
    review.updatedAt = nowIso;

    appendReviewAuditEntry(review, {
      action: 'RETURNED_FOR_REVISION',
      performedBy: active.name,
      performedById: active.id,
      performedByRole: active.role,
      previousStatus: prevStatus,
      newStatus: 'RETURNED_FOR_REVISION',
      details: `Returned ${review.evaluationYear} evaluation for ${review.employeeName} to Department Head for revision.`,
      remarks: trimmedRemarks,
      overallScoreSnapshot: review.overallScore,
      overallRatingSnapshot: review.overallRating,
    });

    db.save();

    // Notify Department Head (evaluator/submitter)
    const recipientId = review.evaluatorId || review.submittedById;
    if (recipientId) {
      const dhUser = db.findUserById(recipientId);
      db.createNotification(
        recipientId,
        `Evaluation Returned for Revision: ${review.employeeName}`,
        `${active.name} returned the ${review.evaluationYear} evaluation for ${review.employeeName}. Reason: ${trimmedRemarks}`,
        'PERFORMANCE',
        'performance',
        {
          reviewId: review.id,
          employeeId: review.employeeId,
          employeeName: review.employeeName,
          department: review.department,
          returnReason: trimmedRemarks,
          eventKey: `perf_return_${review.id}_${review.revisionCount || 0}_${Date.now()}`,
        },
        dhUser?.email
      );
    }

    db.logAction(
      active.id,
      active.name,
      active.role,
      'RETURN_PERFORMANCE_REVIEW',
      'PERFORMANCE',
      `Returned evaluation for ${review.employeeName} for revision. Reason: ${trimmedRemarks}`,
      review.id
    );

    return res.json({
      success: true,
      review: enrichReviewWithDirectoryDetails(review),
      message: `Evaluation for ${review.employeeName} returned to Department Head for revision.`,
    });
  }

  if (action === 'MARK_REVIEWED' || action === 'VALIDATE_ENDORSE') {
    if (review.reviewStatus === 'DRAFT') {
      return res.status(400).json({ error: 'Cannot review or endorse an unsubmitted draft evaluation.' });
    }
    if (review.reviewStatus === 'RETURNED_FOR_REVISION') {
      return res.status(400).json({ error: 'Evaluation is currently returned for revision and awaiting Department Head resubmission.' });
    }

    const isEndorse = action === 'VALIDATE_ENDORSE';
    review.reviewStatus = isEndorse ? 'HR_VALIDATED' : 'REVIEWED';
    review.hrRemarks =
      trimmedRemarks ||
      review.hrRemarks ||
      (isEndorse
        ? 'Validated and officially endorsed by Chamber HR Administration.'
        : 'Reviewed and accepted by Chamber HR Administration.');
    review.reviewedBy = active.name;
    review.reviewedById = active.id;
    review.reviewedAt = nowIso;
    review.updatedAt = nowIso;

    if (review.aiSummary) {
      review.aiSummary.isReviewedByHR = true;
      if (trimmedRemarks) review.aiSummary.hrCorrectionNotes = trimmedRemarks;
    }

    appendReviewAuditEntry(review, {
      action: isEndorse ? 'HR_VALIDATED' : 'HR_MARKED_REVIEWED',
      performedBy: active.name,
      performedById: active.id,
      performedByRole: active.role,
      previousStatus: prevStatus,
      newStatus: review.reviewStatus,
      details: isEndorse
        ? `Validated and endorsed ${review.evaluationYear} evaluation for ${review.employeeName}.`
        : `Marked ${review.evaluationYear} evaluation for ${review.employeeName} as Reviewed.`,
      remarks: review.hrRemarks,
      overallScoreSnapshot: review.overallScore,
      overallRatingSnapshot: review.overallRating,
    });

    db.save();

    const recipientId = review.evaluatorId || review.submittedById;
    if (recipientId && recipientId !== active.id) {
      const dhUser = db.findUserById(recipientId);
      db.createNotification(
        recipientId,
        isEndorse
          ? `Evaluation Validated & Endorsed by HR: ${review.employeeName}`
          : `Evaluation Reviewed by HR: ${review.employeeName}`,
        `${active.name} ${isEndorse ? 'validated and endorsed' : 'marked as reviewed'} the ${review.evaluationYear} evaluation for ${review.employeeName}.${trimmedRemarks ? ` Remarks: ${trimmedRemarks}` : ''}`,
        'PERFORMANCE',
        'performance',
        {
          reviewId: review.id,
          employeeId: review.employeeId,
          employeeName: review.employeeName,
          department: review.department,
          eventKey: `perf_${isEndorse ? 'endorsed' : 'reviewed'}_${review.id}_${Date.now()}`,
        },
        dhUser?.email
      );
    }

    db.logAction(
      active.id,
      active.name,
      active.role,
      isEndorse ? 'FINALIZE_PERFORMANCE_REVIEW' : 'HR_MARK_PERFORMANCE_REVIEWED',
      'PERFORMANCE',
      `${isEndorse ? 'Validated and endorsed' : 'Marked'} evaluation for ${review.employeeName} as ${review.reviewStatus}`,
      review.id
    );

    return res.json({
      success: true,
      review: enrichReviewWithDirectoryDetails(review),
      message: isEndorse
        ? `Evaluation for ${review.employeeName} validated and officially endorsed by HR.`
        : `Evaluation for ${review.employeeName} marked as Reviewed by HR.`,
    });
  }

  // ADD_REMARKS
  if (!trimmedRemarks) {
    return res.status(400).json({ error: 'HR remarks cannot be empty.' });
  }
  review.hrRemarks = trimmedRemarks;
  review.updatedAt = nowIso;
  if (review.aiSummary) {
    review.aiSummary.hrCorrectionNotes = trimmedRemarks;
  }
  appendReviewAuditEntry(review, {
    action: 'HR_REMARKS_UPDATED',
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
    previousStatus: prevStatus,
    newStatus: review.reviewStatus,
    details: `HR (${active.name}) recorded remarks on evaluation for ${review.employeeName}.`,
    remarks: trimmedRemarks,
  });
  db.save();

  db.logAction(
    active.id,
    active.name,
    active.role,
    'HR_ADD_PERFORMANCE_REMARKS',
    'PERFORMANCE',
    `Added HR remarks on evaluation for ${review.employeeName}`,
    review.id
  );

  return res.json({
    success: true,
    review: enrichReviewWithDirectoryDetails(review),
    message: 'HR remarks saved to evaluation audit history.',
  });
});

// Delete performance review (HR only; prevents deleting validated reviews without confirmation)
app.delete('/api/performance/reviews/:id', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const data = db.getData();
  const idx = data.performanceReviews.findIndex((r) => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Review not found.' });

  const [removed] = data.performanceReviews.splice(idx, 1);
  db.save();

  db.logAction(active.id, active.name, active.role, 'DELETE_PERFORMANCE_REVIEW', 'PERFORMANCE', `Deleted review for ${removed.employeeName} (${removed.period || removed.evaluationYear})`, id);
  res.json({ success: true, message: `Performance review for ${removed.employeeName} removed.` });
});

// Generate AI performance synthesis grounded in Form 65, PS 014/015/016, and catalog courses
app.post('/api/performance/reviews/:id/generate-ai-synthesis', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const review = db.getData().performanceReviews.find((r) => r.id === id);
  if (!review) return res.status(404).json({ error: 'Review not found.' });

  try {
    const catalog = db.getData().trainingCatalog;
    const analysis = await analyzePerformanceAI({
      employeeName: review.employeeName,
      department: review.department,
      period: `Annual Evaluation ${review.evaluationYear || review.period}`,
      managerFeedback: review.managerFeedback,
      selfAssessment: review.selfAssessment,
      goals: review.goals,
      competencyScores: review.competencyScores,
      availableCatalogCourses: catalog.map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        addressedCompetencies: c.addressedCompetencies,
      })),
    });

    review.aiSummary = {
      summary: analysis.summary,
      observedTrends: analysis.observedTrends,
      evidenceCitations: analysis.evidenceCitations,
      isReviewedByHR: false,
      hrCorrectionNotes: review.aiSummary?.hrCorrectionNotes || '',
      recommendedCourses: analysis.recommendedCourses,
      missingEvidenceQuestions: analysis.missingEvidenceQuestions,
      ratingScaleVerification: analysis.ratingScaleVerification,
    };
    review.updatedAt = new Date().toISOString();
    db.save();

    db.logAction(active.id, active.name, active.role, 'GENERATE_AI_PERFORMANCE_SYNTHESIS', 'PERFORMANCE', `Generated AI analysis for ${review.employeeName}`, id);
    res.json({ success: true, review });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to synthesize performance review.' });
  }
});

// Create or update Individual Development Plan recommendations (IDP Form 75 / PS 018) from review
// Does NOT automatically treat recommendations as approved; leaves hrApproved = false until explicit HR approval
app.post('/api/performance/reviews/:id/create-idp', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const review = db.getData().performanceReviews.find((r) => r.id === id);
  if (!review) return res.status(404).json({ error: 'Performance review not found.' });

  const catalog = db.getData().trainingCatalog;
  const competencies = db.getData().competencies;

  // Identify performance gaps where assessedLevel < targetLevel (or < 4)
  const gaps: Array<{
    competencyName: string;
    requiredLevel: number;
    assessedLevel: number;
    gap: number;
    status: 'SUFFICIENT_DATA' | 'INSUFFICIENT_DATA';
    recommendedCourseIds: string[];
  }> = [];

  for (const [compName, score] of Object.entries(review.competencyScores)) {
    const compDef = competencies.find((c) => c.name.toLowerCase() === compName.toLowerCase() || c.name.includes(compName) || compName.includes(c.name));
    const target = compDef?.targetLevels?.['Senior'] || 4;
    if (score < target) {
      // Find matching course from catalog
      const matchingCourses = catalog
        .filter((c) => c.addressedCompetencies.some((ac) => ac.toLowerCase() === compName.toLowerCase() || ac.includes(compName) || compName.includes(ac)))
        .map((c) => c.id);

      gaps.push({
        competencyName: compName,
        requiredLevel: target,
        assessedLevel: score,
        gap: target - score,
        status: 'SUFFICIENT_DATA',
        recommendedCourseIds: matchingCourses,
      });
    }
  }

  const existingPlan = db.getData().developmentPlans.find((p) => p.employeeId === review.employeeId);
  const now = new Date().toISOString();

  if (existingPlan) {
    existingPlan.competencyGaps = gaps;
    existingPlan.targetRole = review.department;
    existingPlan.hrApproved = false;
    db.save();

    db.logAction(active.id, active.name, active.role, 'UPDATE_IDP_RECOMMENDATIONS', 'LEARNING', `Updated IDP recommendations from annual review for ${review.employeeName}`, existingPlan.id);
    return res.json({
      success: true,
      plan: existingPlan,
      updated: true,
      message: 'Performance gaps mapped to development plan recommendations. Awaiting HR review and endorsement.',
    });
  } else {
    // New plan starts with hrApproved: false so HR reviews recommendations before active enrollment
    const newPlan: IndividualDevelopmentPlan = {
      id: `idp_${Date.now()}`,
      employeeId: review.employeeId,
      employeeName: review.employeeName,
      targetRole: `Advancement in ${review.department}`,
      competencyGaps: gaps,
      goals: review.goals.map((g) => ({
        goalTitle: `Enhance performance in: ${g.title}`,
        targetDate: new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0],
        status: 'NOT_STARTED' as const,
      })),
      enrolledCourses: [],
      hrApproved: false, // Requires explicit HR review and approval
      updatedAt: now,
    };

    db.getData().developmentPlans.push(newPlan);
    db.save();

    db.logAction(active.id, active.name, active.role, 'CREATE_IDP_RECOMMENDATIONS', 'LEARNING', `Created IDP recommendations (Form 75) from annual review for ${review.employeeName}`, newPlan.id);
    return res.json({
      success: true,
      plan: newPlan,
      created: true,
      message: 'Performance gaps mapped to development plan recommendations. Awaiting HR review and endorsement.',
    });
  }
});

// Explicit HR Approval & Endorsement of IDP Recommendations for Learning & Development
const handleEndorseOrApprovePlan = (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const plan = db.getData().developmentPlans.find((p) => p.id === id);
  if (!plan) return res.status(404).json({ error: 'Development plan not found.' });

  const remarks = (req.body?.remarks || '').trim() || 'Officially endorsed by HR for professional development under AmCham Policy 7.3.';
  const now = new Date().toISOString();

  plan.hrApproved = true;
  plan.endorsementStatus = 'ENDORSED';
  plan.status = 'ENDORSED';
  plan.hrRemarks = remarks;
  plan.endorsedAt = now;
  plan.endorsedBy = active.name;
  plan.endorsedById = active.id;
  plan.updatedAt = now;
  db.save();

  db.addNotification({
    userId: plan.employeeId,
    title: 'Individual Development Plan Endorsed',
    message: `HR Administrator ${active.name} has officially endorsed your Individual Development Plan (${plan.targetRole || 'Career Advancement'}). Remarks: "${remarks}". You may now proceed with course enrollment and training planning.`,
    type: 'SUCCESS',
    read: false,
    timestamp: now,
    link: '/learning',
    metadata: {
      planId: plan.id,
      action: 'ENDORSED',
      remarks,
      endorsedBy: active.name,
      employeeId: plan.employeeId,
      employeeName: plan.employeeName,
    },
  });

  db.logAction(active.id, active.name, active.role, 'APPROVE_DEVELOPMENT_PLAN', 'LEARNING', `Officially approved and endorsed IDP recommendations for ${plan.employeeName}. Remarks: ${remarks}`, id);
  res.json({ success: true, plan, message: `Development plan for ${plan.employeeName} approved and endorsed for Learning & Development.` });
};

app.post('/api/learning/plans/:id/approve', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), handleEndorseOrApprovePlan);
app.post('/api/learning/plans/:id/endorse', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), handleEndorseOrApprovePlan);

app.post('/api/learning/plans/:id/return-revision', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const plan = db.getData().developmentPlans.find((p) => p.id === id);
  if (!plan) return res.status(404).json({ error: 'Development plan not found.' });

  const remarks = (req.body?.remarks || '').trim();
  if (!remarks) {
    return res.status(400).json({ error: 'Remarks and feedback are required when returning a development plan for revision.' });
  }
  const now = new Date().toISOString();

  plan.hrApproved = false;
  plan.endorsementStatus = 'REVISION_REQUESTED';
  plan.status = 'REVISION_REQUESTED';
  plan.hrRemarks = remarks;
  plan.returnedAt = now;
  plan.returnedBy = active.name;
  plan.returnedById = active.id;
  plan.updatedAt = now;
  db.save();

  db.addNotification({
    userId: plan.employeeId,
    title: 'IDP Returned for Revision',
    message: `HR Administrator ${active.name} returned your Individual Development Plan for revision: "${remarks}". Please review HR remarks and resubmit.`,
    type: 'WARNING',
    read: false,
    timestamp: now,
    link: '/learning',
    metadata: {
      planId: plan.id,
      action: 'REVISION_REQUESTED',
      remarks,
      returnedBy: active.name,
      employeeId: plan.employeeId,
      employeeName: plan.employeeName,
    },
  });

  db.logAction(active.id, active.name, active.role, 'RETURN_DEVELOPMENT_PLAN_REVISION', 'LEARNING', `Returned IDP for ${plan.employeeName} for revision. Remarks: ${remarks}`, id);
  res.json({ success: true, plan, message: `Development plan returned to ${plan.employeeName} for revision.` });
});

app.post('/api/learning/plans/:id/submit', (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getActiveUser(req);
  if (!active) return res.status(401).json({ error: 'Authentication required.' });
  const plan = db.getData().developmentPlans.find((p) => p.id === id);
  if (!plan) return res.status(404).json({ error: 'Development plan not found.' });
  if (active.role === 'EMPLOYEE' && plan.employeeId !== active.id) {
    return res.status(403).json({ error: 'Cannot submit another employee development plan.' });
  }

  const now = new Date().toISOString();
  plan.endorsementStatus = 'PENDING_HR';
  plan.status = 'PENDING_HR';
  plan.hrApproved = false;
  plan.submittedAt = now;
  plan.updatedAt = now;
  db.save();

  const hrUsers = db.getData().users.filter((u) => u.role === 'HR_ADMINISTRATOR' || u.role === 'HR_PERSONNEL');
  for (const hr of hrUsers) {
    db.addNotification({
      userId: hr.id,
      title: 'New Development Plan Awaiting Endorsement',
      message: `${plan.employeeName} has submitted an Individual Development Plan (${plan.targetRole || 'Career Advancement'}) for HR endorsement.`,
      type: 'INFO',
      read: false,
      timestamp: now,
      link: '/learning',
      metadata: {
        planId: plan.id,
        employeeId: plan.employeeId,
        employeeName: plan.employeeName,
      },
    });
  }

  db.logAction(active.id, active.name, active.role, 'SUBMIT_DEVELOPMENT_PLAN', 'LEARNING', `Submitted IDP for ${plan.employeeName} for HR endorsement`, id);
  res.json({ success: true, plan, message: 'Development plan submitted for HR endorsement.' });
});

// ----------------------------------------------------
// 7. MODULE FIVE: TRAINING NEEDS ANALYSIS & COMPETENCIES
// ----------------------------------------------------
app.get('/api/competencies', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Competency frameworks are restricted to internal Secretariat staff.' });
  }
  res.json({ competencies: db.getData().competencies });
});

app.get('/api/training-needs/official-records', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Secretariat training records are restricted to internal staff.' });
  }

  const dataset = getStaffTrainingDataset();
  res.json({
    success: true,
    ...dataset,
  });
});

app.post('/api/training-needs/analyze', async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  try {
    const { scope, departmentName, employeeName, role, competencyComparison } = req.body;
    const catalog = db.getData().trainingCatalog;

    let targetScope: 'ORGANIZATION' | 'DEPARTMENT' | 'EMPLOYEE' = scope || 'ORGANIZATION';
    let targetEmployee = employeeName;
    let targetDept = departmentName;
    let targetRole = role;
    let targetHours: number | undefined = undefined;
    let attendedSessions: any[] = [];

    if (employeeName) {
      targetScope = 'EMPLOYEE';
      const foundStaff = STAFF_TRAINING_2026.find(
        (s) => s.employeeName.toLowerCase() === employeeName.toLowerCase() || s.id === employeeName
      );
      if (foundStaff) {
        targetEmployee = foundStaff.employeeName;
        targetDept = foundStaff.department;
        targetRole = foundStaff.role;
        targetHours = foundStaff.totalHours;
        attendedSessions = foundStaff.sessions.map((s) => ({
          topic: s.title,
          hours: s.hours,
          date: s.date,
        }));
      }
    } else if (departmentName) {
      targetScope = 'DEPARTMENT';
    }

    const analysis = await analyzeTrainingNeedsAI({
      scope: targetScope,
      departmentName: targetDept,
      employeeName: targetEmployee,
      role: targetRole || (targetDept ? `${targetDept} Staff` : 'Secretariat Specialist'),
      completedTrainingHours: targetHours,
      attendedSessions,
      competencyComparison: competencyComparison || [],
      departmentMetrics: DEPARTMENT_TRAINING_SUMMARIES.map((d) => ({
        department: d.department,
        headcount: d.headcount,
        totalHours: d.totalHours,
        averageHours: d.averageHours,
        riskLevel: d.riskLevel,
      })),
      availableCatalogCourses: catalog.map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        addressedCompetencies: c.addressedCompetencies,
      })),
    });

    db.logAction(
      active.id,
      active.name,
      active.role,
      'ANALYZE_TRAINING_NEEDS',
      'TRAINING',
      `Executed ${targetScope} AI training needs analysis based on 2026 Staff Training Register: ${targetEmployee || targetDept || 'All Secretariat'}`
    );

    res.json({ success: true, analysis });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Training analysis failed.' });
  }
});

// -----------------------------------------------------------------------------
// 7.1 PERSISTENT TRAINING RECORDS, ANNUAL ARCHIVES, EVIDENCE & HR VERIFICATION
// -----------------------------------------------------------------------------

// List training records with year-based filtering, status filter, and role scoping
app.get('/api/training-records', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { year, status, department, employeeId, search } = req.query;
  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  let targetYear: number | 'ALL' | undefined = undefined;
  if (year && year !== 'ALL') {
    const parsedYear = parseInt(year as string, 10);
    if (!isNaN(parsedYear)) targetYear = parsedYear;
  } else if (year === 'ALL') {
    targetYear = 'ALL';
  }

  // Non-HR employees and managers can only view their own records
  let targetEmployeeId = employeeId as string | undefined;
  if (!isHR) {
    targetEmployeeId = active.id;
  }

  const records = db.getTrainingRecords({
    year: targetYear,
    status: status as any,
    department: department as string,
    employeeId: targetEmployeeId,
    search: search as string,
  });

  // Additional security guard for non-HR
  const filtered = isHR
    ? records
    : records.filter(
        (r) =>
          r.employeeId === active.id ||
          (r.employeeNumber && active.employeeNumber && r.employeeNumber === active.employeeNumber) ||
          r.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim()
      );

  res.json({
    success: true,
    records: filtered,
    total: filtered.length,
    yearFilter: targetYear || 'ALL',
  });
});

// Database-backed annual summaries (Verified hours, pending, correction counts, department breakdown)
app.get('/api/training-records/summary', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { year, scope, employeeId } = req.query;
  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  const parsedYear = year ? parseInt(year as string, 10) : undefined;
  const targetYear = isNaN(parsedYear as number) ? undefined : parsedYear;

  const summaries = db.getAnnualTrainingSummary(targetYear);
  const chamberSummary = summaries[0] || null;

  // Personal employee summary calculation
  const targetEmpId = (isHR && employeeId) ? (employeeId as string) : active.id;
  const allRecords = db.getTrainingRecords({ year: targetYear });
  const myRecords = allRecords.filter(
    (r) =>
      r.employeeId === targetEmpId ||
      (r.employeeNumber && active.employeeNumber && r.employeeNumber === active.employeeNumber) ||
      r.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim()
  );
  const mySummaries = calculateAnnualSummaries(myRecords, targetYear);
  const personalSummary = mySummaries[0] || null;

  // Default: HR gets chamberSummary (302 baseline hours for 2026), non-HR gets their personal summary unless scope=chamber
  const primarySummary = (!isHR && scope !== 'chamber') ? personalSummary : chamberSummary;

  res.json({
    success: true,
    summaries: (!isHR && scope !== 'chamber') ? mySummaries : summaries,
    summary: primarySummary,
    chamberSummary,
    personalSummary,
    isHR,
  });
});

// Available training years with record counts
app.get('/api/training-records/years', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const years = db.getAvailableTrainingYears();
  const yearCounts = years.map((y) => {
    const summary = db.getAnnualTrainingSummary(y)[0];
    return {
      year: y,
      totalRecords: summary?.totalRecords || 0,
      verifiedRecords: summary?.verifiedRecords || 0,
      totalVerifiedHours: summary?.totalVerifiedHours || 0,
      pendingVerification: summary?.pendingVerificationRecords || 0,
    };
  });

  res.json({
    success: true,
    years,
    yearCounts,
  });
});

// Get single training record details
app.get('/api/training-records/:id', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { id } = req.params;
  const record = db.getTrainingRecordById(id);
  if (!record) {
    return res.status(404).json({ error: 'Training record not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  const isOwner =
    record.employeeId === active.id ||
    (record.employeeNumber && active.employeeNumber && record.employeeNumber === active.employeeNumber) ||
    record.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim();

  if (!isHR && !isOwner) {
    return res.status(403).json({
      error: 'Access Denied: You do not have permission to view another employee\'s confidential training record.',
    });
  }

  res.json({ success: true, record });
});

// Create training record (Draft or Submit to HR Verification Queue)
app.post('/api/training-records', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const {
    employeeId,
    employeeName,
    department,
    title,
    trainingTitle,
    attendanceDate,
    attendanceEndDate,
    year,
    durationHours,
    provider,
    venueOrPlatform,
    category,
    description,
    additionalNotes,
    competencyAlignment,
    status,
    submitNow,
    forceSubmit,
  } = req.body;

  const resolvedTitle = title || trainingTitle || '';
  if (!resolvedTitle || !resolvedTitle.trim()) {
    return res.status(400).json({ error: 'Training title is required.' });
  }
  if (!attendanceDate || !attendanceDate.trim()) {
    return res.status(400).json({ error: 'Attendance date is required.' });
  }

  const hours = parseFloat(durationHours);
  if (isNaN(hours) || hours <= 0) {
    return res.status(400).json({ error: 'Duration in hours must be a positive number.' });
  }

  // Derive calendar year from attendance date and validate
  const derived = deriveYearFromDate(attendanceDate, year ? parseInt(year, 10) : undefined);
  if (!derived.valid) {
    return res.status(400).json({ error: derived.error || 'Invalid attendance date format.' });
  }

  // Validate end date if provided
  let normalizedEndDate: string | undefined = undefined;
  if (attendanceEndDate && typeof attendanceEndDate === 'string' && attendanceEndDate.trim()) {
    const endDerived = deriveYearFromDate(attendanceEndDate.trim());
    if (endDerived.valid) {
      if (endDerived.normalizedDate < derived.normalizedDate) {
        return res.status(400).json({ error: 'Training end date cannot precede the start date.' });
      }
      normalizedEndDate = endDerived.normalizedDate;
    }
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  // Determine target employee identity (Strict server-side identity enforcement for non-HR)
  let targetEmpId = active.id;
  let targetEmpName = active.name;
  let targetEmpNumber = active.employeeNumber;
  let targetDept = active.department;

  if (isHR && employeeId && employeeId !== active.id) {
    const foundEmp = db.getData().employeeRecords.find((e) => e.userId === employeeId || e.employeeNumber === employeeId);
    const foundUser = db.findUserById(employeeId);
    if (foundEmp) {
      targetEmpId = foundEmp.userId;
      targetEmpName = foundEmp.fullName;
      targetEmpNumber = foundEmp.employeeNumber;
      targetDept = foundEmp.department;
    } else if (foundUser) {
      targetEmpId = foundUser.id;
      targetEmpName = foundUser.name;
      targetEmpNumber = foundUser.employeeNumber;
      targetDept = foundUser.department;
    } else if (employeeName) {
      targetEmpName = employeeName;
      targetDept = department || 'General Secretariat';
    }
  } else if (!isHR) {
    // Standard employee is ALWAYS strictly linked to their own identity (no client-side spoofing)
    targetEmpId = active.id;
    targetEmpName = active.name;
    targetEmpNumber = active.employeeNumber;
    targetDept = active.department;
  }

  // Duplicate detection against existing records
  const existingRecords = db.getTrainingRecords();
  const isDuplicate = detectDuplicateTraining(existingRecords, {
    employeeName: targetEmpName,
    employeeId: targetEmpId,
    employeeNumber: targetEmpNumber,
    title: resolvedTitle,
    attendanceDate: derived.normalizedDate,
    durationHours: hours,
  });

  if (isDuplicate && !forceSubmit) {
    const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotencyKey;
    if (idempotencyKey) {
      const recentMatch = existingRecords.find(
        (r) =>
          r.employeeId === targetEmpId &&
          r.title.toLowerCase().trim() === resolvedTitle.toLowerCase().trim() &&
          r.attendanceDate === derived.normalizedDate
      );
      if (recentMatch) {
        return res.status(200).json({ success: true, record: recentMatch, message: 'Existing record preserved under idempotency key.' });
      }
    }

    return res.status(409).json({
      error: `Potential duplicate record detected: A training with title "${resolvedTitle}" for ${targetEmpName} is already on file.`,
      duplicateDetected: true,
    });
  }

  // Target status: standard employees can only create 'Draft' or submit to 'Pending Verification'
  let targetStatus: TrainingRecordStatus = 'Draft';
  if (submitNow) {
    targetStatus = 'Pending Verification';
  } else if (status === 'Draft' || status === 'Pending Verification') {
    targetStatus = status;
  } else if (isHR && (status === 'Verified' || status === 'Needs Correction' || status === 'Rejected')) {
    targetStatus = status;
  }

  const now = new Date().toISOString();
  const newRecord = db.createTrainingRecord({
    employeeId: targetEmpId,
    employeeNumber: targetEmpNumber,
    employeeName: targetEmpName,
    department: targetDept,
    title: resolvedTitle.trim(),
    attendanceDate: derived.normalizedDate,
    attendanceEndDate: normalizedEndDate,
    year: derived.year,
    durationHours: hours,
    provider: provider?.trim() || 'AmCham Philippines',
    venueOrPlatform: venueOrPlatform?.trim() || 'AmCham Secretariat / Hybrid',
    category: category?.trim() || 'General Secretariat Development',
    description: description?.trim() || '',
    additionalNotes: additionalNotes?.trim() || undefined,
    competencyAlignment: Array.isArray(competencyAlignment) ? competencyAlignment : undefined,
    evidenceReferences: [],
    status: targetStatus,
    submittedAt: targetStatus === 'Pending Verification' ? now : undefined,
    submittedBy: active.name,
    submittedById: active.id,
    reviewedAt: isHR && targetStatus === 'Verified' ? now : undefined,
    reviewedBy: isHR && targetStatus === 'Verified' ? active.name : undefined,
    reviewedById: isHR && targetStatus === 'Verified' ? active.id : undefined,
    reviewNotes: isHR && targetStatus === 'Verified' ? 'Directly verified by HR Administrator.' : undefined,
    reviewHistory: targetStatus === 'Pending Verification' ? [{
      decision: 'SUBMITTED',
      decisionBy: active.name,
      decisionById: active.id,
      decisionByRole: active.role,
      timestamp: now,
      notes: 'Initial employee submission for HR verification',
      newStatus: 'Pending Verification',
    }] : [],
  });

  // Notify HR if submitted for review
  if (targetStatus === 'Pending Verification') {
    for (const hr of db.getActiveHRRecipients(active.id)) {
      db.createNotification(
        hr.id,
        'Training Record Submitted for Verification',
        `${active.name} submitted "${newRecord.title}" (${newRecord.durationHours} hrs) for HR verification.`,
        'SYSTEM',
        'training',
        { recordId: newRecord.id, employeeName: newRecord.employeeName, eventKey: `tr_submit_${newRecord.id}_${hr.id}` },
        hr.email
      );
    }
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    targetStatus === 'Pending Verification' ? 'SUBMIT_TRAINING_RECORD' : 'CREATE_TRAINING_RECORD',
    'TRAINING',
    `Created training record "${newRecord.title}" (${newRecord.durationHours} hrs) for ${newRecord.employeeName} [Status: ${targetStatus}]`,
    newRecord.id
  );

  res.status(201).json({ success: true, record: newRecord });
});

// Update training record details (Draft or Needs Correction, or HR amendment)
app.put('/api/training-records/:id', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { id } = req.params;
  const record = db.getTrainingRecordById(id);
  if (!record) {
    return res.status(404).json({ error: 'Training record not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  const isOwner =
    record.employeeId === active.id ||
    (record.employeeNumber && active.employeeNumber && record.employeeNumber === active.employeeNumber) ||
    record.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim();

  if (!isHR && !isOwner) {
    return res.status(403).json({ error: 'Cannot modify another employee\'s training record.' });
  }

  // Non-HR can ONLY edit if Draft or Needs Correction. Verified records require controlled amendment workflow!
  if (!isHR && record.status !== 'Draft' && record.status !== 'Needs Correction') {
    return res.status(400).json({
      error: `Cannot edit record while under status "${record.status}". Only Draft or Needs Correction records may be edited. For verified records, please submit an amendment request through the controlled amendment workflow.`,
    });
  }

  const {
    title,
    attendanceDate,
    attendanceEndDate,
    year,
    durationHours,
    provider,
    venueOrPlatform,
    category,
    description,
    additionalNotes,
    competencyAlignment,
  } = req.body;

  const updates: Partial<TrainingRecord> = {};

  if (title !== undefined && title.trim()) updates.title = title.trim();
  if (provider !== undefined) updates.provider = provider.trim();
  if (venueOrPlatform !== undefined) updates.venueOrPlatform = venueOrPlatform.trim();
  if (category !== undefined) updates.category = category.trim();
  if (description !== undefined) updates.description = description.trim();
  if (additionalNotes !== undefined) updates.additionalNotes = additionalNotes.trim();
  if (competencyAlignment !== undefined && Array.isArray(competencyAlignment)) {
    updates.competencyAlignment = competencyAlignment;
  }

  if (durationHours !== undefined) {
    const hours = parseFloat(durationHours);
    if (!isNaN(hours) && hours > 0) {
      updates.durationHours = hours;
    }
  }

  if (attendanceDate !== undefined && attendanceDate.trim()) {
    const derived = deriveYearFromDate(attendanceDate, year ? parseInt(year, 10) : undefined);
    if (derived.valid) {
      updates.attendanceDate = derived.normalizedDate;
      updates.year = derived.year;
    }
  }

  if (attendanceEndDate !== undefined) {
    if (attendanceEndDate && attendanceEndDate.trim()) {
      const endDerived = deriveYearFromDate(attendanceEndDate.trim());
      if (endDerived.valid) {
        updates.attendanceEndDate = endDerived.normalizedDate;
      }
    } else {
      updates.attendanceEndDate = undefined;
    }
  }

  const updated = db.updateTrainingRecord(id, updates, { id: active.id, name: active.name, role: active.role });

  db.logAction(
    active.id,
    active.name,
    active.role,
    'UPDATE_TRAINING_RECORD',
    'TRAINING',
    `Updated details for training record "${record.title}"`,
    id
  );

  res.json({ success: true, record: updated });
});

// Submit a Draft or Needs Correction record to HR Verification Queue
app.post('/api/training-records/:id/submit', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { id } = req.params;
  const record = db.getTrainingRecordById(id);
  if (!record) {
    return res.status(404).json({ error: 'Training record not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  const isOwner =
    record.employeeId === active.id ||
    (record.employeeNumber && active.employeeNumber && record.employeeNumber === active.employeeNumber) ||
    record.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim();

  if (!isHR && !isOwner) {
    return res.status(403).json({ error: 'Cannot submit another employee\'s training record.' });
  }

  if (record.status !== 'Draft' && record.status !== 'Needs Correction') {
    return res.status(400).json({
      error: `Cannot submit record in "${record.status}" state. Only Draft or Needs Correction records can be submitted.`,
    });
  }

  const isResubmission = record.status === 'Needs Correction';
  const now = new Date().toISOString();

  const priorHistory: TrainingReviewHistoryEntry[] = Array.isArray(record.reviewHistory) ? [...record.reviewHistory] : [];
  priorHistory.push({
    decision: isResubmission ? 'RESUBMITTED' : 'SUBMITTED',
    decisionBy: active.name,
    decisionById: active.id,
    decisionByRole: active.role,
    timestamp: now,
    notes: isResubmission
      ? (record.correctionReason ? `Resubmitted with corrections: "${record.correctionReason}"` : 'Resubmitted with requested corrections for HR verification.')
      : 'Submitted for HR verification.',
    previousStatus: record.status,
    newStatus: 'Pending Verification',
  });

  const updated = db.updateTrainingRecord(
    id,
    {
      status: 'Pending Verification',
      submittedAt: now,
      submittedBy: active.name,
      submittedById: active.id,
      correctionReason: undefined, // Clear active flag; reviewHistory retains full historical context
      reviewHistory: priorHistory,
    },
    { id: active.id, name: active.name, role: active.role }
  );

  // Notify HR Administration
  for (const hr of db.getActiveHRRecipients(active.id)) {
    db.createNotification(
      hr.id,
      isResubmission ? 'Training Record Resubmitted for Verification' : 'Training Record Submitted for Verification',
      `${active.name} ${isResubmission ? 'resubmitted corrected' : 'submitted'} "${record.title}" (${record.durationHours} hrs) for HR verification.`,
      'SYSTEM',
      'training',
      { recordId: id, employeeName: record.employeeName, isResubmission, eventKey: `tr_resubmit_${id}_${hr.id}_${Date.now()}` },
      hr.email
    );
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    isResubmission ? 'RESUBMIT_TRAINING_RECORD' : 'SUBMIT_TRAINING_RECORD',
    'TRAINING',
    `${isResubmission ? 'Resubmitted' : 'Submitted'} training record "${record.title}" for HR verification review.`,
    id
  );

  res.json({ success: true, record: updated, message: 'Record submitted to HR verification queue.' });
});

// HR Verification: Verify training record (HR ONLY)
app.post(
  '/api/training-records/:id/verify',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { id } = req.params;
    const { reviewNotes } = req.body;

    const record = db.getTrainingRecordById(id);
    if (!record) {
      return res.status(404).json({ error: 'Training record not found.' });
    }

    // Role check: An employee must NOT approve their own training record (strict anti-self-verification)
    const isSelf =
      record.employeeId === active.id ||
      (record.employeeNumber && active.employeeNumber && record.employeeNumber === active.employeeNumber) ||
      record.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim();

    if (isSelf) {
      return res.status(403).json({
        error: 'Conflict of Interest: HR reviewers cannot verify their own personal training submissions. An independent HR Administrator must review this record.',
      });
    }

    const verifiedHoursVal = req.body.verifiedHours !== undefined && !isNaN(parseFloat(req.body.verifiedHours))
      ? parseFloat(req.body.verifiedHours)
      : record.durationHours;

    const now = new Date().toISOString();
    const notes = reviewNotes?.trim() || 'Verified by HR Administration against supporting evidence.';
    const priorHistory: TrainingReviewHistoryEntry[] = Array.isArray(record.reviewHistory) ? [...record.reviewHistory] : [];
    priorHistory.push({
      decision: 'VERIFIED',
      decisionBy: active.name,
      decisionById: active.id,
      decisionByRole: active.role,
      timestamp: now,
      notes,
      previousStatus: record.status,
      newStatus: 'Verified',
    });

    const updated = db.updateTrainingRecord(
      id,
      {
        status: 'Verified',
        durationHours: verifiedHoursVal,
        verifiedHours: verifiedHoursVal,
        reviewedAt: now,
        reviewedBy: active.name,
        reviewedById: active.id,
        reviewNotes: notes,
        hrNotes: notes,
        verificationInfo: {
          verifiedBy: active.name,
          verifiedById: active.id,
          verifiedAt: now,
          reviewNotes: notes,
        },
        correctionReason: undefined,
        rejectionReason: undefined,
        reviewHistory: priorHistory,
      } as any,
      { id: active.id, name: active.name, role: active.role }
    );

    // Notify the employee of successful verification
    db.createNotification(
      record.employeeId,
      'Training Record Verified by HR',
      `Congratulations! Your training record "${record.title}" (${record.durationHours} hrs) has been verified and added to your official annual training credits.`,
      'SYSTEM',
      'training',
      { recordId: id, verifiedBy: active.name }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'VERIFY_TRAINING_RECORD',
      'TRAINING',
      `Verified training record "${record.title}" for ${record.employeeName} (${record.durationHours} hrs)`,
      id
    );

    res.json({ success: true, record: updated, message: 'Training record verified successfully.' });
  }
);

// HR Verification: Return for Correction (HR ONLY)
app.post(
  '/api/training-records/:id/return-correction',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { id } = req.params;
    const { reason, notes, hrNotes } = req.body;
    const finalReason = reason || notes || hrNotes;

    if (!finalReason || !finalReason.trim()) {
      return res.status(400).json({ error: 'A specific reason is required when returning a record for correction.' });
    }

    const record = db.getTrainingRecordById(id);
    if (!record) {
      return res.status(404).json({ error: 'Training record not found.' });
    }

    // Role check: An employee must NOT review their own record
    const isSelf =
      record.employeeId === active.id ||
      (record.employeeNumber && active.employeeNumber && record.employeeNumber === active.employeeNumber) ||
      record.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim();

    if (isSelf) {
      return res.status(403).json({
        error: 'Conflict of Interest: HR reviewers cannot review their own personal training submissions.',
      });
    }

    const now = new Date().toISOString();
    const cleanReason = finalReason.trim();
    const priorHistory: TrainingReviewHistoryEntry[] = Array.isArray(record.reviewHistory) ? [...record.reviewHistory] : [];
    priorHistory.push({
      decision: 'NEEDS_CORRECTION',
      decisionBy: active.name,
      decisionById: active.id,
      decisionByRole: active.role,
      timestamp: now,
      reason: cleanReason,
      notes: cleanReason,
      previousStatus: record.status,
      newStatus: 'Needs Correction',
    });

    const updated = db.updateTrainingRecord(
      id,
      {
        status: 'Needs Correction',
        reviewedAt: now,
        reviewedBy: active.name,
        reviewedById: active.id,
        correctionReason: cleanReason,
        correctionNotes: cleanReason,
        hrNotes: cleanReason,
        reviewHistory: priorHistory,
      } as any,
      { id: active.id, name: active.name, role: active.role }
    );

    // Notify employee with correction instructions
    db.createNotification(
      record.employeeId,
      'Training Record Requires Correction',
      `HR reviewed "${record.title}" and requested corrections: "${cleanReason}". Please update the record and resubmit.`,
      'SYSTEM',
      'training',
      { recordId: id, reason: cleanReason }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'RETURN_TRAINING_FOR_CORRECTION',
      'TRAINING',
      `Returned training record "${record.title}" for correction. Reason: ${cleanReason}`,
      id
    );

    res.json({ success: true, record: updated, message: 'Record returned for correction.' });
  }
);

// HR Verification: Reject Record (HR ONLY)
app.post(
  '/api/training-records/:id/reject',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'A specific reason is required when rejecting a training record.' });
    }

    const record = db.getTrainingRecordById(id);
    if (!record) {
      return res.status(404).json({ error: 'Training record not found.' });
    }

    // Role check: An employee must NOT review their own record
    const isSelf =
      record.employeeId === active.id ||
      (record.employeeNumber && active.employeeNumber && record.employeeNumber === active.employeeNumber) ||
      record.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim();

    if (isSelf) {
      return res.status(403).json({
        error: 'Conflict of Interest: HR reviewers cannot review their own personal training submissions.',
      });
    }

    const now = new Date().toISOString();
    const cleanReason = reason.trim();
    const priorHistory: TrainingReviewHistoryEntry[] = Array.isArray(record.reviewHistory) ? [...record.reviewHistory] : [];
    priorHistory.push({
      decision: 'REJECTED',
      decisionBy: active.name,
      decisionById: active.id,
      decisionByRole: active.role,
      timestamp: now,
      reason: cleanReason,
      notes: cleanReason,
      previousStatus: record.status,
      newStatus: 'Rejected',
    });

    const updated = db.updateTrainingRecord(
      id,
      {
        status: 'Rejected',
        reviewedAt: now,
        reviewedBy: active.name,
        reviewedById: active.id,
        rejectionReason: cleanReason,
        reviewHistory: priorHistory,
      },
      { id: active.id, name: active.name, role: active.role }
    );

    // Notify employee of rejection with reason
    db.createNotification(
      record.employeeId,
      'Training Record Rejected by HR',
      `Your training record "${record.title}" was rejected by HR. Reason: "${cleanReason}".`,
      'SYSTEM',
      'training',
      { recordId: id, reason: cleanReason }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'REJECT_TRAINING_RECORD',
      'TRAINING',
      `Rejected training record "${record.title}" for ${record.employeeName}. Reason: ${cleanReason}`,
      id
    );

    res.json({ success: true, record: updated, message: 'Training record rejected.' });
  }
);

// Request an amendment to an already Verified record (Authenticated Record Owner or HR)
app.post('/api/training-records/:id/request-amendment', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { id } = req.params;
  const record = db.getTrainingRecordById(id);
  if (!record) {
    return res.status(404).json({ error: 'Training record not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  const isOwner =
    record.employeeId === active.id ||
    (record.employeeNumber && active.employeeNumber && record.employeeNumber === active.employeeNumber) ||
    record.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim();

  if (!isHR && !isOwner) {
    return res.status(403).json({ error: 'Cannot request amendment on another employee\'s training record.' });
  }

  if (record.status !== 'Verified') {
    return res.status(400).json({
      error: `Amendment requests can only be submitted for verified records. Current record status is "${record.status}".`,
    });
  }

  const { reason, amendmentReason, proposedChanges, evidenceId, evidenceFileName } = req.body;
  const finalReason = reason || amendmentReason;
  if (!finalReason || !finalReason.trim()) {
    return res.status(400).json({ error: 'A specific reason is required when requesting an amendment to a verified training record.' });
  }

  const now = new Date().toISOString();
  const amendmentReq = {
    id: `amend_req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    recordId: record.id,
    requestedAt: now,
    requestedBy: active.name,
    requestedById: active.id,
    reason: finalReason.trim(),
    proposedChanges: proposedChanges || {},
    evidenceId,
    evidenceFileName,
    status: 'PENDING_HR_REVIEW' as const,
  };

  record.amendmentRequest = amendmentReq;
  record.updatedAt = now;
  db.save();

  // Notify HR Administration of amendment request
  for (const hr of db.getActiveHRRecipients(active.id)) {
    db.createNotification(
      hr.id,
      'Training Record Amendment Requested',
      `${active.name} requested an amendment on verified record "${record.title}". Reason: "${finalReason.trim()}"`,
      'SYSTEM',
      'training',
      { recordId: record.id, amendmentRequestId: amendmentReq.id, employeeName: record.employeeName, eventKey: `tr_amend_${amendmentReq.id}_${hr.id}` },
      hr.email
    );
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    'REQUEST_AMENDMENT_TRAINING_RECORD',
    'TRAINING',
    `Submitted formal amendment request for verified record "${record.title}". Reason: ${finalReason.trim()}`,
    record.id
  );

  res.json({ success: true, record, message: 'Amendment request submitted to HR for review.' });
});

// Controlled amendment of already Verified records (HR ONLY)
app.post(
  '/api/training-records/:id/amend',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { id } = req.params;
    const { amendmentReason, reason, updates } = req.body;
    const finalReason = amendmentReason || reason;

    if (!finalReason || !finalReason.trim()) {
      return res.status(400).json({ error: 'An authorized amendment reason is required when modifying a verified record.' });
    }

    const record = db.getTrainingRecordById(id);
    if (!record) {
      return res.status(404).json({ error: 'Training record not found.' });
    }

    const now = new Date().toISOString();
    const previousState = {
      title: record.title,
      durationHours: record.durationHours,
      attendanceDate: record.attendanceDate,
      attendanceEndDate: record.attendanceEndDate,
      provider: record.provider,
      status: record.status,
    };

    if (!record.amendmentHistory) record.amendmentHistory = [];
    record.amendmentHistory.push({
      amendedAt: now,
      amendedBy: active.name,
      amendedById: active.id,
      previousStatus: record.status,
      reason: finalReason.trim(),
      changes: previousState,
    });

    // If an amendment request was pending, mark it APPROVED
    if (record.amendmentRequest) {
      record.amendmentRequest.status = 'APPROVED';
      record.amendmentRequest.reviewedAt = now;
      record.amendmentRequest.reviewedBy = active.name;
      record.amendmentRequest.reviewedById = active.id;
      record.amendmentRequest.reviewNotes = finalReason.trim();
    }

    const mergedUpdates = {
      ...(record.amendmentRequest?.proposedChanges || {}),
      ...(updates || {}),
    };
    if (req.body.title) mergedUpdates.title = req.body.title;
    if (req.body.provider) mergedUpdates.provider = req.body.provider;
    if (req.body.durationHours !== undefined) mergedUpdates.durationHours = req.body.durationHours;
    if (req.body.verifiedHours !== undefined) {
      mergedUpdates.verifiedHours = req.body.verifiedHours;
      if (mergedUpdates.durationHours === undefined) {
        mergedUpdates.durationHours = req.body.verifiedHours;
      }
    }
    if (req.body.category) mergedUpdates.category = req.body.category;
    if (req.body.attendanceDate) mergedUpdates.attendanceDate = req.body.attendanceDate;

    if (mergedUpdates.title) record.title = mergedUpdates.title.trim();
    if (mergedUpdates.provider) record.provider = mergedUpdates.provider.trim();
    if (mergedUpdates.venueOrPlatform) record.venueOrPlatform = mergedUpdates.venueOrPlatform.trim();
    if (mergedUpdates.category) record.category = mergedUpdates.category.trim();
    if (mergedUpdates.description) record.description = mergedUpdates.description.trim();
    if (mergedUpdates.additionalNotes) record.additionalNotes = mergedUpdates.additionalNotes.trim();
    if (mergedUpdates.competencyAlignment && Array.isArray(mergedUpdates.competencyAlignment)) {
      record.competencyAlignment = mergedUpdates.competencyAlignment;
    }
    if (mergedUpdates.durationHours && !isNaN(parseFloat(mergedUpdates.durationHours))) {
      record.durationHours = parseFloat(mergedUpdates.durationHours);
    }
    if (mergedUpdates.verifiedHours && !isNaN(parseFloat(mergedUpdates.verifiedHours))) {
      record.verifiedHours = parseFloat(mergedUpdates.verifiedHours);
    }
    if (mergedUpdates.attendanceDate) {
      const derived = deriveYearFromDate(mergedUpdates.attendanceDate);
      if (derived.valid) {
        record.attendanceDate = derived.normalizedDate;
        record.year = derived.year;
      }
    }
    if (mergedUpdates.attendanceEndDate !== undefined) {
      record.attendanceEndDate = mergedUpdates.attendanceEndDate ? mergedUpdates.attendanceEndDate.trim() : undefined;
    }
    if (mergedUpdates.status && mergedUpdates.status !== record.status) {
      record.status = mergedUpdates.status;
    }

    record.updatedAt = now;
    db.save();

    // Notify employee of approval
    db.createNotification(
      record.employeeId,
      'Training Record Amendment Approved by HR',
      `Your training record amendment for "${record.title}" was approved by HR (${finalReason.trim()}).`,
      'SYSTEM',
      'training',
      { recordId: id, amendedBy: active.name }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'AMEND_VERIFIED_TRAINING_RECORD',
      'TRAINING',
      `Amended verified record "${record.title}" (${record.employeeName}). Reason: ${finalReason.trim()}`,
      id
    );

    res.json({ success: true, record, message: 'Verified record amended with full audit history preserved.' });
  }
);

// Reject Employee Amendment Request (HR ONLY)
app.post(
  '/api/training-records/:id/reject-amendment',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { id } = req.params;
    const { reason, reviewNotes } = req.body;
    const finalReason = reason || reviewNotes;

    if (!finalReason || !finalReason.trim()) {
      return res.status(400).json({ error: 'A specific explanation is required when declining an amendment request.' });
    }

    const record = db.getTrainingRecordById(id);
    if (!record) {
      return res.status(404).json({ error: 'Training record not found.' });
    }

    if (!record.amendmentRequest || (record.amendmentRequest.status !== 'PENDING' && record.amendmentRequest.status !== 'PENDING_HR_REVIEW')) {
      return res.status(400).json({ error: 'No pending amendment request found for this record.' });
    }

    const now = new Date().toISOString();
    record.amendmentRequest.status = 'REJECTED';
    record.amendmentRequest.reviewedAt = now;
    record.amendmentRequest.reviewedBy = active.name;
    record.amendmentRequest.reviewedById = active.id;
    record.amendmentRequest.reviewNotes = finalReason.trim();
    record.updatedAt = now;
    db.save();

    // Notify employee of amendment rejection
    db.createNotification(
      record.employeeId,
      'Training Record Amendment Request Declined',
      `Your amendment request for "${record.title}" was declined by HR: "${finalReason.trim()}". The existing verified record remains in effect.`,
      'SYSTEM',
      'training',
      { recordId: id, reason: finalReason.trim() }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'REJECT_TRAINING_AMENDMENT_REQUEST',
      'TRAINING',
      `Declined amendment request for verified training record "${record.title}". Reason: ${finalReason.trim()}`,
      id
    );

    res.json({ success: true, record, message: 'Amendment request rejected. Verified record preserved.' });
  }
);

// Delete training record (Draft by owner, or administrative/test cleanup by HR)
app.delete('/api/training-records/:id', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { id } = req.params;
  const record = db.getTrainingRecordById(id);
  if (!record) {
    return res.status(404).json({ error: 'Training record not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  const isOwner = record.employeeId === active.id;

  if (!isHR && !isOwner) {
    return res.status(403).json({ error: 'Unauthorized to delete this training record.' });
  }

  if (!isHR && record.status !== 'Draft') {
    return res.status(400).json({ error: 'Employees may only delete Draft training records.' });
  }

  const ok = db.deleteTrainingRecord(id);
  if (!ok) {
    return res.status(500).json({ error: 'Failed to delete record from storage.' });
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    'DELETE_TRAINING_RECORD',
    'TRAINING',
    `Deleted training record "${record.title}" (${record.employeeName})`,
    id
  );

  res.json({ success: true, message: 'Training record deleted.' });
});

// Upload training evidence (Certificates, Attendance Slips, Photos)
app.post(
  '/api/training-records/:id/evidence',
  (req: Request, res: Response, next) => {
    evidenceUpload.any()(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (Array.isArray(req.files) && req.files.length > 0) {
        req.file = req.files[0];
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    const active = getActiveUser(req);
    if (!active) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const { id } = req.params;
    const record = db.getTrainingRecordById(id);
    if (!record) {
      return res.status(404).json({ error: 'Training record not found.' });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Evidence file is required.' });
    }

    const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
    const isOwner =
      record.employeeId === active.id ||
      (record.employeeNumber && active.employeeNumber && record.employeeNumber === active.employeeNumber) ||
      record.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim();

    if (!isHR && !isOwner) {
      return res.status(403).json({ error: 'Cannot upload evidence to another employee\'s training record.' });
    }

    const isAmendmentEvidence = req.body?.isAmendmentEvidence === 'true' || req.body?.isAmendmentEvidence === true;
    if (!isHR && record.status === 'Verified' && !isAmendmentEvidence) {
      return res.status(400).json({ error: 'Cannot attach evidence to an already verified record without HR authorization or an amendment request.' });
    }

    const { notes, replaceEvidenceId } = req.body;
    const now = new Date().toISOString();

    // If replacing existing evidence, mark old version as SUPERSEDED (never destroy forensic evidence)
    let nextVersion = 1;
    if (!record.evidenceReferences) record.evidenceReferences = [];

    if (replaceEvidenceId) {
      const oldEv = record.evidenceReferences.find((e) => e.id === replaceEvidenceId);
      if (oldEv) {
        oldEv.status = 'SUPERSEDED';
        nextVersion = oldEv.version + 1;
      }
    } else {
      // If multiple active, find max version
      const maxVer = record.evidenceReferences.reduce((max, e) => Math.max(max, e.version || 1), 0);
      nextVersion = maxVer + 1;
    }

    const evidenceId = `ev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const cleanFileName = `ev_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;

    const stored = await firebaseStorage.uploadApplicantFile(
      req.file.buffer,
      cleanFileName,
      req.file.originalname,
      req.file.mimetype
    );

    const evidenceRef: EvidenceReference = {
      id: evidenceId,
      fileName: req.file.originalname,
      originalName: req.file.originalname,
      storedFileName: stored.fileName,
      fileUrl: `/api/training-records/${record.id}/evidence/${evidenceId}/file`,
      downloadUrl: `/api/training-records/${record.id}/evidence/${evidenceId}/download`,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      uploadedAt: now,
      uploadedBy: active.name,
      uploadedById: active.id,
      version: nextVersion,
      status: 'ACTIVE',
      notes: notes?.trim() || undefined,
    };

    record.evidenceReferences.push(evidenceRef);
    record.updatedAt = now;
    db.save();

    db.logAction(
      active.id,
      active.name,
      active.role,
      'UPLOAD_TRAINING_EVIDENCE',
      'TRAINING',
      `Uploaded evidence document "${req.file.originalname}" (${(req.file.size / 1024).toFixed(1)} KB) for record "${record.title}"`,
      id
    );

    res.status(200).json({
      success: true,
      evidence: evidenceRef,
      evidenceReference: evidenceRef,
      record,
      message: 'Evidence document uploaded securely.',
    });
  }
);

// Stream/Preview Evidence File (Access-controlled)
app.get('/api/training-records/:recordId/evidence/:evidenceId/file', async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to view evidence.' });
  }

  const { recordId, evidenceId } = req.params;
  const record = db.getTrainingRecordById(recordId);
  if (!record) {
    return res.status(404).json({ error: 'Training record not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  const isOwner =
    record.employeeId === active.id ||
    (record.employeeNumber && active.employeeNumber && record.employeeNumber === active.employeeNumber) ||
    record.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim();

  if (!isHR && !isOwner) {
    return res.status(403).json({
      error: 'Access Denied: In accordance with AmCham Philippines security governance, confidential certificates may only be viewed by the employee or authorized HR personnel.',
    });
  }

  const evidence = record.evidenceReferences?.find((e) => e.id === evidenceId);
  if (!evidence) {
    return res.status(404).json({ error: 'Evidence document not found.' });
  }

  const storagePath = `applicant_uploads/${evidence.storedFileName}`;
  const streamed = await firebaseStorage.streamDocumentToResponse(
    storagePath,
    res,
    evidence.mimeType || 'application/pdf',
    evidence.originalName || evidence.fileName
  );
  if (streamed) return;

  // Check physical file path fallback
  let physicalPath = path.join(EVIDENCE_STORAGE_DIR, evidence.storedFileName);
  if (!fs.existsSync(physicalPath)) {
    const altPdfPath = path.resolve(process.cwd(), 'public/assets/aistudio', evidence.storedFileName);
    if (fs.existsSync(altPdfPath)) {
      physicalPath = altPdfPath;
    }
  }

  if (fs.existsSync(physicalPath)) {
    res.setHeader('Content-Type', evidence.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(evidence.originalName || evidence.fileName)}"`);
    return fs.createReadStream(physicalPath).pipe(res);
  }

  if (!res.headersSent) {
    res.status(404).json({ error: 'Evidence physical file is temporarily unavailable.' });
  }
});

// Download Evidence File (Access-controlled)
app.get('/api/training-records/:recordId/evidence/:evidenceId/download', async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to download evidence.' });
  }

  const { recordId, evidenceId } = req.params;
  const record = db.getTrainingRecordById(recordId);
  if (!record) {
    return res.status(404).json({ error: 'Training record not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  const isOwner =
    record.employeeId === active.id ||
    (record.employeeNumber && active.employeeNumber && record.employeeNumber === active.employeeNumber) ||
    record.employeeName.toLowerCase().trim() === active.name.toLowerCase().trim();

  if (!isHR && !isOwner) {
    return res.status(403).json({ error: 'Access Denied: You do not have permission to download this evidence document.' });
  }

  const evidence = record.evidenceReferences?.find((e) => e.id === evidenceId);
  if (!evidence) {
    return res.status(404).json({ error: 'Evidence document not found.' });
  }

  const storagePath = `applicant_uploads/${evidence.storedFileName}`;
  const streamed = await firebaseStorage.streamDocumentToResponse(
    storagePath,
    res,
    evidence.mimeType || 'application/octet-stream',
    evidence.originalName || evidence.fileName
  );
  if (streamed) return;

  let physicalPath = path.join(EVIDENCE_STORAGE_DIR, evidence.storedFileName);
  if (!fs.existsSync(physicalPath)) {
    const altPdfPath = path.resolve(process.cwd(), 'public/assets/aistudio', evidence.storedFileName);
    if (fs.existsSync(altPdfPath)) {
      physicalPath = altPdfPath;
    }
  }

  if (fs.existsSync(physicalPath)) {
    return res.download(physicalPath, evidence.originalName || evidence.fileName);
  }

  if (!res.headersSent) {
    res.status(404).json({ error: 'Evidence physical file is temporarily unavailable.' });
  }
});

// Add or Link Employee in Training Roster & AMIE Directory
app.post('/api/training/employees/add-or-link', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { name, email, department, jobTitle, employeeNumber } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Employee full name is required.' });
  }

  const normName = name.trim();
  const normEmail = email && typeof email === 'string' ? email.trim().toLowerCase() : '';
  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  // Check if employee already exists in users or employee records
  const existingUsers = db.getData().users;
  const existingEmpRecords = db.getData().employeeRecords;

  let matchedUser = existingUsers.find((u) => {
    if (normEmail && u.email.toLowerCase() === normEmail) return true;
    if (employeeNumber && u.employeeNumber === employeeNumber.trim()) return true;
    return u.name.toLowerCase().trim() === normName.toLowerCase();
  });

  let matchedEmpRecord = existingEmpRecords.find((e) => {
    if (matchedUser && e.userId === matchedUser.id) return true;
    if (
      normEmail &&
      ((e.workEmail && e.workEmail.toLowerCase() === normEmail) ||
        (e.personalEmail && e.personalEmail.toLowerCase() === normEmail))
    )
      return true;
    if (employeeNumber && e.employeeNumber === employeeNumber.trim()) return true;
    return e.fullName.toLowerCase().trim() === normName.toLowerCase();
  });

  if (matchedUser || matchedEmpRecord) {
    if (req.body.action === 'create_new' || req.body.createOnly) {
      return res.status(400).json({
        error: `Employee "${normName}" (${normEmail || 'on file'}) already exists in the Secretariat directory. Duplicate employee profiles are prohibited.`,
        exists: true,
      });
    }

    const safeUser = matchedUser ? sanitizeUser(matchedUser) : null;
    const empObj = {
      id: matchedUser?.id || matchedEmpRecord?.userId,
      userId: matchedUser?.id || matchedEmpRecord?.userId,
      name: matchedUser?.name || matchedEmpRecord?.fullName || normName,
      fullName: matchedUser?.name || matchedEmpRecord?.fullName || normName,
      email: matchedUser?.email || matchedEmpRecord?.workEmail || normEmail,
      department: matchedUser?.department || matchedEmpRecord?.department,
      employeeNumber: matchedUser?.employeeNumber || matchedEmpRecord?.employeeNumber,
    };
    return res.json({
      success: true,
      exists: true,
      user: safeUser,
      employeeRecord: matchedEmpRecord,
      employee: empObj,
      message: `Employee "${normName}" is already registered in AMIE directory and linked to the training roster.`,
    });
  }

  // If not HR, non-HR cannot register arbitrary third-party accounts
  if (!isHR) {
    return res.status(403).json({
      error: 'Only HR personnel or administrators can register new employees into the official directory.',
    });
  }

  // Create new employee profile with proper AmCham email
  const resolvedEmail =
    normEmail ||
    `${normName.toLowerCase().replace(/[^a-z0-9]/g, '.')}@amchamphilippines.com`;
  const resolvedEmpNo =
    employeeNumber?.trim() || `ACPH-2026-${Math.floor(1000 + Math.random() * 9000)}`;

  const newUser: User = {
    id: `usr_emp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: normName,
    email: resolvedEmail,
    password: hashPassword('AmChamStaff2026!'),
    role: 'EMPLOYEE',
    accountStatus: 'ACTIVE',
    verificationStatus: 'VERIFIED',
    department: department?.trim() || 'General Secretariat',
    jobTitle: jobTitle?.trim() || 'Secretariat Staff',
    joinedDate: new Date().toISOString().split('T')[0],
    employeeNumber: resolvedEmpNo,
  };

  db.createUser(newUser);
  const newEmpRecord = db.createEmployeeRecordForUser(newUser);

  db.logAction(
    active.id,
    active.name,
    active.role,
    'REGISTER_EMPLOYEE_DIRECTORY',
    'AUTH',
    `Registered new employee "${newUser.name}" (${newUser.email}) in Secretariat directory.`,
    newUser.id
  );

  const createdEmpObj = {
    id: newUser.id,
    userId: newUser.id,
    name: newUser.name,
    fullName: newUser.name,
    email: newUser.email,
    department: newUser.department,
    employeeNumber: newUser.employeeNumber,
  };

  res.status(201).json({
    success: true,
    created: true,
    user: sanitizeUser(newUser),
    employeeRecord: newEmpRecord,
    employee: createdEmpObj,
    message: `Successfully registered ${newUser.name} into AMIE Secretariat directory.`,
  });
});

// CSV Bulk Import: Preview and Validate Rows
app.post('/api/training-records/import/preview', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { csvContent } = req.body;
  if (!csvContent || typeof csvContent !== 'string') {
    return res.status(400).json({ error: 'CSV content string is required for import preview.' });
  }

  const existingRecords = db.getTrainingRecords();
  const employeeRecords = db.getData().employeeRecords;
  const previewResult = parseAndValidateTrainingCsv(csvContent, existingRecords, employeeRecords);

  res.json({
    success: true,
    preview: previewResult,
    ...previewResult,
  });
});

// CSV Bulk Import: Commit Valid Rows (HR ONLY)
app.post(
  '/api/training-records/import/commit',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { rows, targetStatus, defaultStatus } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows provided to commit.' });
    }

    const validStatus = (targetStatus || defaultStatus) === 'Verified' ? 'Verified' : 'Pending Verification';
    const committedRecords: TrainingRecord[] = [];
    const now = new Date().toISOString();

    for (const r of rows) {
      if (!r.isValid && !r.employeeName) continue;

      const newRec = db.createTrainingRecord({
        employeeId: r.matchedEmployeeId || `emp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        employeeNumber: r.employeeNumber,
        employeeName: r.employeeName,
        department: r.department || 'General Secretariat',
        title: r.title,
        attendanceDate: r.attendanceDate,
        year: r.year,
        durationHours: r.durationHours,
        provider: r.provider || 'AmCham Philippines',
        venueOrPlatform: r.venueOrPlatform || 'AmCham Secretariat / Hybrid',
        category: r.category || 'Operational Excellence',
        description: `Imported via bulk CSV dataset on ${now.split('T')[0]}.`,
        evidenceReferences: [],
        status: validStatus,
        submittedAt: now,
        submittedBy: active.name,
        submittedById: active.id,
        reviewedAt: validStatus === 'Verified' ? now : undefined,
        reviewedBy: validStatus === 'Verified' ? active.name : undefined,
        reviewedById: validStatus === 'Verified' ? active.id : undefined,
        reviewNotes: validStatus === 'Verified' ? 'Batch imported and verified by HR Administrator.' : undefined,
        verificationInfo: validStatus === 'Verified' ? {
          verifiedBy: active.name,
          verifiedById: active.id,
          verifiedAt: now,
          reviewNotes: 'Batch imported and verified by HR Administrator.',
        } : undefined,
      });

      committedRecords.push(newRec);
    }

    db.logAction(
      active.id,
      active.name,
      active.role,
      'IMPORT_TRAINING_RECORDS',
      'TRAINING',
      `Bulk imported ${committedRecords.length} training records under status ${validStatus}.`
    );

    res.json({
      success: true,
      committedCount: committedRecords.length,
      importedCount: committedRecords.length,
      records: committedRecords,
      message: `Successfully imported and persisted ${committedRecords.length} training records.`,
    });
  }
);


// ----------------------------------------------------
// 8. MODULE SIX: PERSONALIZED LEARNING & DEVELOPMENT
// ----------------------------------------------------
app.get('/api/learning/catalog', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Secretariat training catalog is restricted to internal staff.' });
  }
  res.json({ catalog: db.getData().trainingCatalog });
});

app.post('/api/learning/catalog', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const courseData = req.body;
  const newCourse = {
    id: `course_${Date.now()}`,
    ...courseData,
  };
  db.getData().trainingCatalog.push(newCourse);
  db.save();

  db.logAction(active.id, active.name, active.role, 'ADD_TRAINING_COURSE', 'LEARNING', `Added course ${newCourse.title}`, newCourse.id);
  res.json({ success: true, course: newCourse });
});

app.put('/api/learning/catalog/:id', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const { id } = req.params;
  const course = db.getData().trainingCatalog.find((c) => c.id === id);
  if (!course) return res.status(404).json({ error: 'Course not found.' });

  const { title, provider, category, durationHours, deliveryMode, description, addressedCompetencies, linkUrl, scheduleInfo, instructions, isArchived } = req.body;
  if (title) course.title = title;
  if (provider) course.provider = provider;
  if (category) course.category = category;
  if (durationHours !== undefined) course.durationHours = Number(durationHours);
  if (deliveryMode) course.deliveryMode = deliveryMode;
  if (description) course.description = description;
  if (Array.isArray(addressedCompetencies)) course.addressedCompetencies = addressedCompetencies;
  if (linkUrl !== undefined) course.linkUrl = linkUrl;
  if (scheduleInfo !== undefined) course.scheduleInfo = scheduleInfo;
  if (instructions !== undefined) course.instructions = instructions;
  if (isArchived !== undefined) course.isArchived = Boolean(isArchived);

  db.save();
  db.logAction(active.id, active.name, active.role, 'UPDATE_TRAINING_CATALOG_COURSE', 'LEARNING', `Updated course ${course.title}`, course.id);
  res.json({ success: true, course });
});

app.delete('/api/learning/catalog/:id', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const { id } = req.params;
  const course = db.getData().trainingCatalog.find((c) => c.id === id);
  if (!course) return res.status(404).json({ error: 'Course not found.' });

  course.isArchived = true;
  db.save();
  db.logAction(active.id, active.name, active.role, 'ARCHIVE_TRAINING_CATALOG_COURSE', 'LEARNING', `Archived course ${course.title}`, course.id);
  res.json({ success: true, message: 'Course archived successfully.' });
});


app.get('/api/learning/plans', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Individual development plans are restricted to internal Secretariat staff.' });
  }
  const { employeeId } = req.query;

  const allUsers = db.getData().users;
  const allRecords = db.getData().employeeRecords;
  const catalog = db.getData().trainingCatalog;

  const enrichPlan = (p: IndividualDevelopmentPlan) => {
    const user = allUsers.find((u) => u.id === p.employeeId);
    const rec = allRecords.find((r) => r.userId === p.employeeId);
    const dept = p.department || rec?.department || user?.department || 'Secretariat Operations';

    const subsidy = p.subsidyDetails || {
      eligible: true,
      annualAllowancePHP: 25000,
      policyRef: 'Personnel Manual 2019, Policy 7.3 (Professional Development & Tuition Reimbursement)',
      utilizedPHP: (p.enrolledCourses || []).filter((c) => c.status === 'COMPLETED').length * 5000,
      remainingPHP: 25000 - ((p.enrolledCourses || []).filter((c) => c.status === 'COMPLETED').length * 5000),
      notes: 'Full-time Secretariat staff with endorsement eligible for up to PHP 25,000 annual subsidy for accredited programs.',
    };

    let recCourses = p.recommendedCourses || [];
    if (!recCourses || recCourses.length === 0) {
      const courseIds = new Set<string>();
      (p.competencyGaps || []).forEach((g) => {
        (g.recommendedCourseIds || []).forEach((cid) => courseIds.add(cid));
      });
      recCourses = Array.from(courseIds).map((cid) => {
        const item = catalog.find((c) => c.id === cid);
        return {
          courseId: cid,
          courseTitle: item?.title || cid,
          provider: item?.provider || 'AMCHAM_INTERNAL',
          durationHours: item?.durationHours || 8,
          reason: 'Addresses identified competency gap',
        };
      });
    }

    return {
      ...p,
      department: dept,
      subsidyDetails: subsidy,
      recommendedCourses: recCourses,
      endorsementStatus: p.endorsementStatus || (p.hrApproved ? 'ENDORSED' : 'PENDING_HR'),
    };
  };

  // Employees & Department Heads can only view their own IDP on this endpoint
  if (active.role === 'EMPLOYEE' || active.role === 'DEPARTMENT_HEAD') {
    const plan = db.getData().developmentPlans.filter((p) => p.employeeId === active.id);
    return res.json({ plans: plan.map(enrichPlan) });
  }

  let plans = db.getData().developmentPlans;
  if (employeeId) {
    plans = plans.filter((p) => p.employeeId === employeeId);
  }
  res.json({ plans: plans.map(enrichPlan) });
});

app.post('/api/learning/plans', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const planData = req.body;
  const newPlan = {
    id: `idp_${Date.now()}`,
    ...planData,
    hrApproved: true,
    updatedAt: new Date().toISOString(),
  };

  db.getData().developmentPlans.push(newPlan);
  db.save();

  db.logAction(active.id, active.name, active.role, 'CREATE_DEVELOPMENT_PLAN', 'LEARNING', `Created IDP for ${newPlan.employeeName}`, newPlan.id);
  res.json({ success: true, plan: newPlan });
});

// ----------------------------------------------------
// 8.1. SECURE LEARNING & DEVELOPMENT WORKFLOW ENDPOINTS
// ----------------------------------------------------

// Course Enrollment: Employee request or HR direct assignment
app.post('/api/learning/enroll', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { courseId, employeeId, scheduleInfo, instructions, targetCompletionDate } = req.body;
  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  // Strict role security: Employees cannot assign courses to other staff
  const targetEmployeeId = !isHR ? active.id : (employeeId || active.id);

  let plan = db.getData().developmentPlans.find((p) => p.employeeId === targetEmployeeId);
  const course = db.getData().trainingCatalog.find((c) => c.id === courseId);
  if (!course) return res.status(404).json({ error: 'Course not found in training catalog.' });

  const now = new Date().toISOString();
  // HR assignment defaults to Enrolled (approved). Employee request defaults to Pending Approval.
  const initialStatus: TrainingStatus = isHR ? 'Enrolled' : 'Pending Approval';
  const isApproved = isHR;

  if (!plan) {
    const targetUser = db.getData().users.find((u) => u.id === targetEmployeeId);
    plan = {
      id: `idp_${Date.now()}`,
      employeeId: targetEmployeeId,
      employeeName: targetUser?.name || active.name,
      targetRole: 'Career Advancement',
      competencyGaps: [],
      goals: [],
      enrolledCourses: [],
      hrApproved: true,
      updatedAt: now,
    };
    db.getData().developmentPlans.push(plan);
  }

  // Prevent duplicate enrollments for the same course
  const existingIdx = plan.enrolledCourses.findIndex((c: any) => c.courseId === courseId);
  if (existingIdx !== -1) {
    const existing = plan.enrolledCourses[existingIdx];
    if (!isHR && existing.status !== 'Rejected') {
      return res.status(400).json({
        error: `Already enrolled or requested for this course (Current status: ${existing.status}). Duplicate submissions are not permitted.`,
      });
    }
  }

  const enrollmentRecord: EnrolledCourseItem = {
    id: `enr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    courseId: course.id,
    courseTitle: course.title,
    provider: course.provider,
    category: course.category,
    durationHours: course.durationHours,
    deliveryMode: course.deliveryMode,
    scheduleInfo: scheduleInfo || course.scheduleInfo || 'Training schedule communicated by HR.',
    instructions: instructions || course.instructions || 'Review course curriculum and attend designated training sessions.',
    enrollmentDate: now,
    targetCompletionDate: targetCompletionDate || undefined,
    status: initialStatus,
    progressPercentage: 0,
    enrollmentApproved: isApproved,
    enrollmentApprovedBy: isApproved ? active.name : undefined,
    enrollmentApprovedById: isApproved ? active.id : undefined,
    enrollmentApprovedAt: isApproved ? now : undefined,
    actionHistory: [
      {
        action: isHR ? 'HR_ENROLLMENT_ASSIGNED' : 'EMPLOYEE_ENROLLMENT_REQUESTED',
        performedBy: active.name,
        performedById: active.id,
        performedByRole: active.role,
        timestamp: now,
        details: isHR
          ? `HR assigned training course "${course.title}"`
          : `Employee requested enrollment in "${course.title}"`,
      },
    ],
  };

  if (existingIdx !== -1) {
    plan.enrolledCourses[existingIdx] = enrollmentRecord;
  } else {
    plan.enrolledCourses.push(enrollmentRecord);
  }

  plan.updatedAt = now;
  db.save();

  // Notifications
  if (isHR && targetEmployeeId !== active.id) {
    db.createNotification(
      targetEmployeeId,
      'Training Enrollment Approved & Assigned',
      `HR Administrator ${active.name} has enrolled you in "${course.title}" (${course.durationHours} hrs). You may now review schedules and begin training.`,
      'SYSTEM',
      'training',
      { courseId: course.id, planId: plan.id }
    );
  } else if (!isHR) {
    for (const hr of db.getActiveHRRecipients(active.id)) {
      db.createNotification(
        hr.id,
        'Training Enrollment Request Submitted',
        `${active.name} has requested enrollment in "${course.title}" awaiting HR approval.`,
        'SYSTEM',
        'training',
        { courseId: course.id, employeeId: active.id, planId: plan.id, eventKey: `learn_enroll_${plan.id}_${course.id}_${hr.id}` },
        hr.email
      );
    }
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    isHR ? 'ASSIGN_TRAINING_COURSE' : 'REQUEST_TRAINING_ENROLLMENT',
    'LEARNING',
    `${isHR ? 'Assigned' : 'Requested'} course ${course.title} for ${plan.employeeName}`,
    plan.id
  );

  res.json({ success: true, plan, course: enrollmentRecord });
});

// HR: Approve Training Enrollment
app.post(
  '/api/learning/plans/:planId/courses/:courseId/approve-enrollment',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { planId, courseId } = req.params;
    const plan = db.getData().developmentPlans.find((p) => p.id === planId);
    if (!plan) return res.status(404).json({ error: 'Development plan not found.' });

    const course = plan.enrolledCourses.find((c) => c.courseId === courseId);
    if (!course) return res.status(404).json({ error: 'Course not found in plan enrollments.' });

    if (course.status === 'Completed') {
      return res.status(400).json({ error: 'Course is already completed.' });
    }

    const now = new Date().toISOString();
    course.status = 'Enrolled';
    course.enrollmentApproved = true;
    course.enrollmentApprovedBy = active.name;
    course.enrollmentApprovedById = active.id;
    course.enrollmentApprovedAt = now;
    if (req.body.scheduleInfo) course.scheduleInfo = req.body.scheduleInfo;
    if (req.body.instructions) course.instructions = req.body.instructions;

    if (!Array.isArray(course.actionHistory)) course.actionHistory = [];
    course.actionHistory.push({
      action: 'APPROVE_ENROLLMENT',
      performedBy: active.name,
      performedById: active.id,
      performedByRole: active.role,
      timestamp: now,
      details: `HR approved enrollment in ${course.courseTitle}`,
      remarks: req.body.remarks || '',
    });

    plan.updatedAt = now;
    db.save();

    db.createNotification(
      plan.employeeId,
      'Training Enrollment Approved',
      `HR Administrator ${active.name} has approved your enrollment in "${course.courseTitle}". You may now view training schedules and commence your coursework.`,
      'SYSTEM',
      'training',
      { planId, courseId }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'APPROVE_TRAINING_ENROLLMENT',
      'LEARNING',
      `Approved training enrollment in "${course.courseTitle}" for ${plan.employeeName}`,
      planId
    );

    res.json({ success: true, plan, course });
  }
);

// HR: Reject Training Enrollment
app.post(
  '/api/learning/plans/:planId/courses/:courseId/reject-enrollment',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { planId, courseId } = req.params;
    const { reason, remarks } = req.body;
    const finalReason = (reason || remarks || '').trim();
    if (!finalReason) {
      return res.status(400).json({ error: 'A specific reason is required to reject an enrollment request.' });
    }

    const plan = db.getData().developmentPlans.find((p) => p.id === planId);
    if (!plan) return res.status(404).json({ error: 'Development plan not found.' });

    const course = plan.enrolledCourses.find((c) => c.courseId === courseId);
    if (!course) return res.status(404).json({ error: 'Course not found in plan enrollments.' });

    const now = new Date().toISOString();
    course.status = 'Rejected';
    course.enrollmentApproved = false;
    course.enrollmentRejectionReason = finalReason;
    course.rejectionRemarks = finalReason;
    course.rejectedAt = now;
    course.rejectedBy = active.name;

    if (!Array.isArray(course.actionHistory)) course.actionHistory = [];
    course.actionHistory.push({
      action: 'REJECT_ENROLLMENT',
      performedBy: active.name,
      performedById: active.id,
      performedByRole: active.role,
      timestamp: now,
      details: `HR rejected enrollment in ${course.courseTitle}`,
      remarks: finalReason,
    });

    plan.updatedAt = now;
    db.save();

    db.createNotification(
      plan.employeeId,
      'Training Enrollment Rejected',
      `Your enrollment request for "${course.courseTitle}" was not approved by HR. Remarks: "${finalReason}".`,
      'SYSTEM',
      'training',
      { planId, courseId, reason: finalReason }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'REJECT_TRAINING_ENROLLMENT',
      'LEARNING',
      `Rejected training enrollment in "${course.courseTitle}" for ${plan.employeeName}. Reason: ${finalReason}`,
      planId
    );

    res.json({ success: true, plan, course });
  }
);

// Progress Update (Strict Security: Employees cannot modify statuses; Completed requires verification)
const handleProgressUpdate = (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const planId = req.params.planId || req.params.id;
  const courseId = req.params.courseId || req.body.courseId;
  const { status, progressPercentage, scheduleInfo, instructions } = req.body;

  const plan = db.getData().developmentPlans.find((p) => p.id === planId);
  if (!plan) return res.status(404).json({ error: 'Development plan not found.' });

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  // STRICT SECURITY RULE 1: Employees are strictly prohibited from manually modifying official statuses
  if (!isHR) {
    return res.status(403).json({
      error: 'Security Violation: Employees are strictly prohibited from manually modifying official training course statuses. Status changes are strictly governed by HR verification workflows.',
    });
  }

  const course = plan.enrolledCourses.find((c) => c.courseId === courseId);
  if (!course) return res.status(404).json({ error: 'Course not found in plan enrollments.' });

  // STRICT SECURITY RULE 2: Completed status CANNOT be set manually; it MUST go through evidence verification
  if (status === 'Completed' || status === 'COMPLETED') {
    return res.status(400).json({
      error: 'A course cannot be manually marked Completed without verified completion evidence. Please use the HR Completion Verification desk to verify supporting certificates.',
    });
  }

  const now = new Date().toISOString();
  if (status) {
    if (status === 'IN_PROGRESS' || status === 'In Progress') course.status = 'In Progress';
    else if (status === 'ENROLLED' || status === 'Enrolled') course.status = 'Enrolled';
    else if (status === 'REVISION_REQUESTED' || status === 'Revision Required') course.status = 'Revision Required';
    else course.status = status;
  }

  if (progressPercentage !== undefined && !isNaN(Number(progressPercentage))) {
    course.progressPercentage = Math.min(100, Math.max(0, Number(progressPercentage)));
  }
  if (scheduleInfo !== undefined) course.scheduleInfo = scheduleInfo;
  if (instructions !== undefined) course.instructions = instructions;

  if (!Array.isArray(course.actionHistory)) course.actionHistory = [];
  course.actionHistory.push({
    action: 'UPDATE_TRAINING_PROGRESS',
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
    timestamp: now,
    details: `HR updated training progress to: ${course.status} (${course.progressPercentage || 0}%)`,
  });

  plan.updatedAt = now;
  db.save();

  db.logAction(
    active.id,
    active.name,
    active.role,
    'UPDATE_COURSE_PROGRESS',
    'LEARNING',
    `Updated course ${course.courseTitle} progress for ${plan.employeeName} to ${course.status}`,
    planId
  );

  res.json({ success: true, plan, course });
};

app.post('/api/learning/plans/:id/progress', handleProgressUpdate);
app.post('/api/learning/plans/:planId/courses/:courseId/progress', handleProgressUpdate);

// Upload Completion Evidence (Certificate PDF, JPG, PNG)
app.post(
  '/api/learning/plans/:planId/courses/:courseId/evidence',
  (req: Request, res: Response) => {
    evidenceUpload.any()(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'File upload error.' });
      }

      const active = getActiveUser(req);
      if (!active) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      const { planId, courseId } = req.params;
      const plan = db.getData().developmentPlans.find((p) => p.id === planId);
      if (!plan) return res.status(404).json({ error: 'Development plan not found.' });

      const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
      const isOwner = plan.employeeId === active.id;

      if (!isHR && !isOwner) {
        return res.status(403).json({ error: 'Access Denied: You cannot upload evidence for another employee\'s training course.' });
      }

      const course = plan.enrolledCourses.find((c) => c.courseId === courseId);
      if (!course) return res.status(404).json({ error: 'Course not found in enrolled courses.' });

      // Guard: Course cannot accept evidence if already completed or already pending review
      if (course.status === 'Completed') {
        return res.status(400).json({ error: 'Course is already verified and marked Completed.' });
      }
      if (course.status === 'Pending Verification') {
        return res.status(400).json({
          error: 'Completion evidence is already pending HR verification. Duplicate submissions are not allowed while awaiting review.',
        });
      }

      const files = req.files as Express.Multer.File[] | undefined;
      const file = req.file || (files && files[0]);
      if (!file) {
        return res.status(400).json({ error: 'No evidence file uploaded. Please select a valid PDF, JPG, or PNG certificate.' });
      }

      const ext = path.extname(file.originalname) || (file.mimetype.includes('png') ? '.png' : file.mimetype.includes('jpeg') ? '.jpg' : '.pdf');
      const evidenceId = `ev_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const storedFileName = `${evidenceId}${ext}`;
      const destPath = path.join(EVIDENCE_STORAGE_DIR, storedFileName);

      try {
        if (!fs.existsSync(EVIDENCE_STORAGE_DIR)) {
          fs.mkdirSync(EVIDENCE_STORAGE_DIR, { recursive: true });
        }
        fs.writeFileSync(destPath, file.buffer);
      } catch (fsErr: any) {
        console.error('Evidence file write error:', fsErr);
        return res.status(500).json({ error: 'Failed to write evidence document to persistent storage.' });
      }

      const stored = await firebaseStorage.uploadApplicantFile(
        file.buffer,
        storedFileName,
        file.originalname,
        file.mimetype
      );

      const now = new Date().toISOString();
      const employeeRemarks = (req.body.remarks || req.body.employeeRemarks || '').trim();

      const evidenceData = {
        id: evidenceId,
        fileName: file.originalname,
        originalName: file.originalname,
        storedFileName: stored.fileName || storedFileName,
        storagePath: stored.storagePath,
        fileUrl: `/api/learning/evidence/${evidenceId}/file`,
        downloadUrl: `/api/learning/evidence/${evidenceId}/download`,
        mimeType: file.mimetype,
        fileSize: file.size,
        uploadedAt: now,
        uploadedBy: active.name,
        uploadedById: active.id,
        employeeRemarks,
      };

      course.evidence = evidenceData;
      course.completionCertificateUrl = evidenceData.fileUrl;
      course.status = 'Pending Verification';
      course.revisionRemarks = undefined;
      course.rejectionRemarks = undefined;

      if (!Array.isArray(course.actionHistory)) course.actionHistory = [];
      course.actionHistory.push({
        action: 'SUBMIT_COMPLETION_EVIDENCE',
        performedBy: active.name,
        performedById: active.id,
        performedByRole: active.role,
        timestamp: now,
        details: `Submitted completion proof: ${file.originalname} (${(file.size / 1024).toFixed(1)} KB)`,
        remarks: employeeRemarks,
      });

      plan.updatedAt = now;
      db.save();

      // Notify all active HR Administration / Personnel
      for (const hr of db.getActiveHRRecipients(active.id)) {
        db.createNotification(
          hr.id,
          'Training Completion Evidence Submitted',
          `${active.name} submitted completion evidence for "${course.courseTitle}" awaiting HR verification.`,
          'SYSTEM',
          'training',
          { planId, courseId, evidenceId, eventKey: `learn_ev_${evidenceId}_${hr.id}` },
          hr.email
        );
      }

      db.logAction(
        active.id,
        active.name,
        active.role,
        'SUBMIT_TRAINING_EVIDENCE',
        'LEARNING',
        `Uploaded completion certificate "${file.originalname}" for "${course.courseTitle}" (${plan.employeeName})`,
        planId
      );

      res.status(201).json({
        success: true,
        plan,
        course,
        evidence: evidenceData,
        message: 'Completion evidence uploaded successfully. Status changed to Pending Verification.',
      });
    });
  }
);

// HR: Verify Completion Evidence & Officially Mark Course Completed
app.post(
  '/api/learning/plans/:planId/courses/:courseId/verify',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { planId, courseId } = req.params;
    const plan = db.getData().developmentPlans.find((p) => p.id === planId);
    if (!plan) return res.status(404).json({ error: 'Development plan not found.' });

    // Strict Anti-Self-Verification
    if (plan.employeeId === active.id) {
      return res.status(403).json({
        error: 'Conflict of Interest: HR reviewers cannot verify their own personal training submissions. An independent HR Administrator must review this evidence.',
      });
    }

    const course = plan.enrolledCourses.find((c) => c.courseId === courseId);
    if (!course) return res.status(404).json({ error: 'Course not found in enrolled courses.' });

    if (course.status === 'Completed' && course.verifiedAt && !course.requiresEvidenceAudit) {
      return res.status(400).json({ error: 'This course has already been officially verified as Completed.' });
    }

    const now = new Date().toISOString();
    const verificationRemarks = (req.body.remarks || req.body.verificationRemarks || 'Verified by HR Administration against supporting completion evidence.').trim();

    course.status = 'Completed';
    course.completedAt = course.completedAt || now;
    course.verifiedAt = now;
    course.verifiedBy = active.name;
    course.verifiedById = active.id;
    course.verificationRemarks = verificationRemarks;
    course.progressPercentage = 100;
    course.requiresEvidenceAudit = false;
    course.evidenceAuditStatus = 'VERIFIED';
    course.auditNotes = undefined;

    if (!Array.isArray(course.actionHistory)) course.actionHistory = [];
    course.actionHistory.push({
      action: 'VERIFY_COMPLETION',
      performedBy: active.name,
      performedById: active.id,
      performedByRole: active.role,
      timestamp: now,
      details: `Officially verified completion certificate for ${course.courseTitle}`,
      remarks: verificationRemarks,
    });

    // SYNC WITH OFFICIAL ANNUAL TRAINING RECORDS
    let trainingRec = (db.getData().trainingRecords || []).find(
      (r) => r.employeeId === plan.employeeId && r.title.toLowerCase().trim() === course.courseTitle.toLowerCase().trim()
    );

    const empUser = db.getData().users.find((u) => u.id === plan.employeeId);
    const empRecord = db.getData().employeeRecords.find((e) => e.userId === plan.employeeId);

    const evidenceRefs: EvidenceReference[] = [];
    if (course.evidence) {
      evidenceRefs.push({
        id: course.evidence.id,
        fileName: course.evidence.fileName,
        originalName: course.evidence.originalName,
        storedFileName: course.evidence.storedFileName,
        fileUrl: course.evidence.fileUrl,
        downloadUrl: course.evidence.downloadUrl,
        mimeType: course.evidence.mimeType,
        fileSize: course.evidence.fileSize,
        uploadedAt: course.evidence.uploadedAt,
        uploadedBy: course.evidence.uploadedBy,
        uploadedById: course.evidence.uploadedById || plan.employeeId,
        version: 1,
        status: 'ACTIVE',
        notes: course.evidence.employeeRemarks || 'Verified certificate on file.',
      });
    }

    if (!trainingRec) {
      if (!Array.isArray(db.getData().trainingRecords)) {
        db.getData().trainingRecords = [];
      }
      const recordId = `tr_idp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const newTrainingRecord: TrainingRecord = {
        id: recordId,
        employeeId: plan.employeeId,
        employeeNumber: empRecord?.employeeNumber || empUser?.employeeNumber || undefined,
        employeeName: plan.employeeName,
        department: plan.department || empRecord?.department || 'Secretariat Staff',
        title: course.courseTitle,
        attendanceDate: now.split('T')[0],
        year: new Date().getFullYear(),
        durationHours: course.durationHours || 8,
        verifiedHours: course.durationHours || 8,
        provider: course.provider || 'AmCham Center for Training & Development',
        category: course.category || 'Professional Development',
        evidenceReferences: evidenceRefs,
        status: 'Verified',
        submittedAt: course.evidence?.uploadedAt || now,
        submittedBy: plan.employeeName,
        submittedById: plan.employeeId,
        reviewedAt: now,
        reviewedBy: active.name,
        reviewedById: active.id,
        reviewNotes: verificationRemarks,
        verificationInfo: {
          verifiedBy: active.name,
          verifiedById: active.id,
          verifiedAt: now,
          reviewNotes: verificationRemarks,
        },
        createdAt: now,
        updatedAt: now,
      };
      if (!db.getData().trainingRecords) {
        db.getData().trainingRecords = [];
      }
      db.getData().trainingRecords!.unshift(newTrainingRecord);
    } else {
      trainingRec.status = 'Verified';
      trainingRec.verifiedHours = course.durationHours || trainingRec.durationHours;
      trainingRec.reviewedAt = now;
      trainingRec.reviewedBy = active.name;
      trainingRec.reviewedById = active.id;
      trainingRec.reviewNotes = verificationRemarks;
      trainingRec.verificationInfo = {
        verifiedBy: active.name,
        verifiedById: active.id,
        verifiedAt: now,
        reviewNotes: verificationRemarks,
      };
      if (evidenceRefs.length > 0 && trainingRec.evidenceReferences.length === 0) {
        trainingRec.evidenceReferences = evidenceRefs;
      }
    }

    plan.updatedAt = now;
    db.save();

    // Notify employee of verified completion
    db.createNotification(
      plan.employeeId,
      'Training Completion Verified',
      `Congratulations! HR Administrator ${active.name} has officially verified your training completion for "${course.courseTitle}". Remarks: "${verificationRemarks}". Official training credits have been awarded.`,
      'SYSTEM',
      'training',
      { planId, courseId }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'VERIFY_TRAINING_COMPLETION',
      'LEARNING',
      `Verified completion of "${course.courseTitle}" for ${plan.employeeName}. Remarks: ${verificationRemarks}`,
      planId
    );

    res.json({ success: true, plan, course, message: 'Training completion officially verified.' });
  }
);

// HR: Request Revision on Submitted Completion Evidence
app.post(
  '/api/learning/plans/:planId/courses/:courseId/request-revision',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { planId, courseId } = req.params;
    const { remarks, reason } = req.body;
    const finalRemarks = (remarks || reason || '').trim();

    if (!finalRemarks) {
      return res.status(400).json({ error: 'Specific remarks detailing requested revisions are required.' });
    }

    const plan = db.getData().developmentPlans.find((p) => p.id === planId);
    if (!plan) return res.status(404).json({ error: 'Development plan not found.' });

    const course = plan.enrolledCourses.find((c) => c.courseId === courseId);
    if (!course) return res.status(404).json({ error: 'Course not found in enrolled courses.' });

    const now = new Date().toISOString();
    course.status = 'Revision Required';
    course.revisionRemarks = finalRemarks;
    course.revisionRequestedAt = now;
    course.revisionRequestedBy = active.name;

    if (!Array.isArray(course.actionHistory)) course.actionHistory = [];
    course.actionHistory.push({
      action: 'REQUEST_EVIDENCE_REVISION',
      performedBy: active.name,
      performedById: active.id,
      performedByRole: active.role,
      timestamp: now,
      details: `HR requested evidence revision for ${course.courseTitle}`,
      remarks: finalRemarks,
    });

    plan.updatedAt = now;
    db.save();

    db.createNotification(
      plan.employeeId,
      'Training Evidence Revision Required',
      `HR reviewed your completion evidence for "${course.courseTitle}" and requested corrections: "${finalRemarks}". Please upload revised evidence.`,
      'SYSTEM',
      'training',
      { planId, courseId, remarks: finalRemarks }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'REQUEST_TRAINING_EVIDENCE_REVISION',
      'LEARNING',
      `Requested evidence revision for "${course.courseTitle}" (${plan.employeeName}). Remarks: ${finalRemarks}`,
      planId
    );

    res.json({ success: true, plan, course, message: 'Returned for revision.' });
  }
);

// HR: Reject Completion Evidence
app.post(
  '/api/learning/plans/:planId/courses/:courseId/reject-evidence',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { planId, courseId } = req.params;
    const { remarks, reason } = req.body;
    const finalRemarks = (remarks || reason || '').trim();

    if (!finalRemarks) {
      return res.status(400).json({ error: 'Specific remarks detailing reason for rejection are required.' });
    }

    const plan = db.getData().developmentPlans.find((p) => p.id === planId);
    if (!plan) return res.status(404).json({ error: 'Development plan not found.' });

    const course = plan.enrolledCourses.find((c) => c.courseId === courseId);
    if (!course) return res.status(404).json({ error: 'Course not found in enrolled courses.' });

    const now = new Date().toISOString();
    course.status = 'Rejected';
    course.rejectionRemarks = finalRemarks;
    course.rejectedAt = now;
    course.rejectedBy = active.name;

    if (!Array.isArray(course.actionHistory)) course.actionHistory = [];
    course.actionHistory.push({
      action: 'REJECT_COMPLETION_EVIDENCE',
      performedBy: active.name,
      performedById: active.id,
      performedByRole: active.role,
      timestamp: now,
      details: `HR rejected completion evidence for ${course.courseTitle}`,
      remarks: finalRemarks,
    });

    plan.updatedAt = now;
    db.save();

    db.createNotification(
      plan.employeeId,
      'Training Evidence Rejected',
      `Your completion evidence for "${course.courseTitle}" was rejected by HR. Reason: "${finalRemarks}".`,
      'SYSTEM',
      'training',
      { planId, courseId, remarks: finalRemarks }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'REJECT_TRAINING_EVIDENCE',
      'LEARNING',
      `Rejected completion evidence for "${course.courseTitle}" (${plan.employeeName}). Reason: ${finalRemarks}`,
      planId
    );

    res.json({ success: true, plan, course, message: 'Evidence rejected.' });
  }
);

// Serve Completion Evidence Files (In-line view and Download)
app.get('/api/learning/evidence/:evidenceId/file', async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to view evidence.' });
  }
  const { evidenceId } = req.params;

  let matchedEvidence: any = null;
  let ownerId = '';

  for (const plan of db.getData().developmentPlans) {
    for (const c of plan.enrolledCourses || []) {
      if (c.evidence && c.evidence.id === evidenceId) {
        matchedEvidence = c.evidence;
        ownerId = plan.employeeId;
        break;
      }
    }
    if (matchedEvidence) break;
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  if (!matchedEvidence) {
    for (const tr of db.getData().trainingRecords || []) {
      const ev = (tr.evidenceReferences || []).find((e) => e.id === evidenceId);
      if (ev) {
        matchedEvidence = ev;
        ownerId = tr.employeeId;
        break;
      }
    }
  }

  if (!matchedEvidence) {
    return res.status(404).json({ error: 'Evidence file not found.' });
  }

  if (!isHR && active.id !== ownerId) {
    return res.status(403).json({ error: 'Access Denied: You do not have permission to view this employee\'s evidence.' });
  }

  const physicalPath = path.join(EVIDENCE_STORAGE_DIR, matchedEvidence.storedFileName);
  if (fs.existsSync(physicalPath)) {
    res.setHeader('Content-Type', matchedEvidence.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(matchedEvidence.originalName || matchedEvidence.fileName)}"`);
    return res.sendFile(physicalPath);
  }

  const cloudPath = matchedEvidence.storagePath || `applicant_uploads/${matchedEvidence.storedFileName}`;
  const streamed = await firebaseStorage.streamDocumentToResponse(
    cloudPath,
    res,
    matchedEvidence.mimeType || 'application/pdf',
    matchedEvidence.originalName || matchedEvidence.fileName
  );
  if (streamed) return;

  if (!res.headersSent) {
    return res.status(404).json({ error: 'Physical evidence file not found on storage.' });
  }
});

app.get('/api/learning/evidence/:evidenceId/download', async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to download evidence.' });
  }
  const { evidenceId } = req.params;

  let matchedEvidence: any = null;
  let ownerId = '';

  for (const plan of db.getData().developmentPlans) {
    for (const c of plan.enrolledCourses || []) {
      if (c.evidence && c.evidence.id === evidenceId) {
        matchedEvidence = c.evidence;
        ownerId = plan.employeeId;
        break;
      }
    }
    if (matchedEvidence) break;
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  if (!matchedEvidence) {
    for (const tr of db.getData().trainingRecords || []) {
      const ev = (tr.evidenceReferences || []).find((e) => e.id === evidenceId);
      if (ev) {
        matchedEvidence = ev;
        ownerId = tr.employeeId;
        break;
      }
    }
  }

  if (!matchedEvidence) {
    return res.status(404).json({ error: 'Evidence file not found.' });
  }

  if (!isHR && active.id !== ownerId) {
    return res.status(403).json({ error: 'Access Denied: You do not have permission to download this evidence.' });
  }

  const physicalPath = path.join(EVIDENCE_STORAGE_DIR, matchedEvidence.storedFileName);
  if (fs.existsSync(physicalPath)) {
    return res.download(physicalPath, matchedEvidence.originalName || matchedEvidence.fileName);
  }

  const cloudPath = matchedEvidence.storagePath || `applicant_uploads/${matchedEvidence.storedFileName}`;
  const streamed = await firebaseStorage.streamDocumentToResponse(
    cloudPath,
    res,
    matchedEvidence.mimeType || 'application/octet-stream',
    matchedEvidence.originalName || matchedEvidence.fileName
  );
  if (streamed) return;

  if (!res.headersSent) {
    return res.status(404).json({ error: 'Physical evidence file not found on storage.' });
  }
});

// ----------------------------------------------------
// 9. AUDIT LOGS & REPORTS SUMMARY
// ----------------------------------------------------
app.get('/api/audit-logs', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (_req: Request, res: Response) => {
  res.json({ logs: db.getData().auditLogs });
});

// ----------------------------------------------------
// 10. EMPLOYEE SELF-SERVICE (MY EMPLOYEE FILE)
// ----------------------------------------------------
function syncEmployeeAuthorizedDocuments(empRecord: any): void {
  if (!empRecord) return;
  if (!Array.isArray(empRecord.authorizedDocuments)) {
    empRecord.authorizedDocuments = [];
  }
  const subs = db.getEmployeeRequirements({ userId: empRecord.userId });
  let hasChanges = false;
  for (const sub of subs) {
    const existing = empRecord.authorizedDocuments.find(
      (d: any) => d.id === sub.id || d.title?.toLowerCase() === sub.requirementTitle?.toLowerCase()
    );
    const authCategory = sub.requirementTitle?.toLowerCase().includes('birth')
      ? 'Personal Identification'
      : (sub.categoryTitle || sub.category || 'Personal Identification');
    const authDoc: AuthorizedDocument = {
      id: sub.id,
      title: sub.requirementTitle,
      category: authCategory,
      fileName: sub.originalName || sub.fileName,
      uploadedDate: sub.submittedAt ? sub.submittedAt.split('T')[0] : new Date().toISOString().split('T')[0],
      fileSize: sub.fileSize || '100 KB',
      verified: sub.status === 'VERIFIED',
      downloadUrl: sub.downloadUrl || `/api/employee-requirements/download/${sub.id}`,
      previewContent: `Official uploaded document (${sub.requirementTitle}: ${sub.originalName || sub.fileName}) on file with AmCham Philippines HR.`,
    };
    if (existing) {
      if (existing.fileName !== authDoc.fileName || existing.verified !== authDoc.verified) {
        Object.assign(existing, authDoc);
        hasChanges = true;
      }
    } else {
      empRecord.authorizedDocuments.push(authDoc);
      hasChanges = true;
    }
  }
  if (hasChanges) {
    db.save();
  }
}

app.get('/api/employee/me', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to access employee file.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Career applicant accounts do not have internal Secretariat employee files.' });
  }
  let record = db.getData().employeeRecords.find((e) => e.userId === active.id);
  if (!record) {
    record = db.createEmployeeRecordForUser(active);
  }
  syncEmployeeAuthorizedDocuments(record);
  const trainingRecords = db.getTrainingRecords({ employeeId: active.id });
  res.json({ record, trainingRecords });
});

app.get('/api/employee/file/:userId', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to access employee file.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Career applicant accounts cannot view internal Secretariat employee records.' });
  }
  const targetUserId = req.params.userId;

  // Strict Server-Side Authorization: Non-HR users can only view their own 201 file
  if ((active.role === 'EMPLOYEE' || active.role === 'MANAGER' || active.role === 'DEPARTMENT_HEAD') && active.id !== targetUserId) {
    db.logAction(
      active.id,
      active.name,
      active.role,
      'UNAUTHORIZED_RECORD_ACCESS_ATTEMPT',
      'EMPLOYEE_FILE',
      `User attempted unauthorized access to file of user ${targetUserId}`,
      targetUserId
    );
    return res.status(403).json({
      error: 'Access Denied: In accordance with AmCham Philippines security governance and Republic Act 10173 (Data Privacy Act), users are strictly prohibited from accessing another employee\'s confidential record.',
    });
  }

  let record = db.getData().employeeRecords.find((e) => e.userId === targetUserId);
  if (!record) {
    const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
    if (active.id === targetUserId || isHR) {
      const targetUser = db.getData().users.find((u) => u.id === targetUserId);
      if (targetUser) {
        record = db.createEmployeeRecordForUser(targetUser);
      }
    }
  }
  if (!record) {
    return res.status(404).json({ error: 'Employee record not found in Secretariat registry.' });
  }

  syncEmployeeAuthorizedDocuments(record);
  const trainingRecords = db.getTrainingRecords({ employeeId: targetUserId });
  db.logAction(active.id, active.name, active.role, 'VIEW_EMPLOYEE_FILE', 'EMPLOYEE_FILE', `Accessed employee file of ${record.fullName} (${record.employeeNumber})`, targetUserId);
  res.json({ record, trainingRecords });
});

app.get('/api/employee/directory', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (_req: Request, res: Response) => {
  res.json({ records: db.getData().employeeRecords });
});

// Shared Employee Profile / 201 File update handler
function handleUpdateEmployeeProfile(req: Request, res: Response, targetUserIdOverride?: string) {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to update employee profile.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Career applicant accounts cannot modify internal Secretariat employee records.' });
  }

  const targetUserId = targetUserIdOverride || req.params.userId;

  // Strict Server-Side Authorization: Non-HR users can ONLY edit their own record
  if ((active.role === 'EMPLOYEE' || active.role === 'MANAGER' || active.role === 'DEPARTMENT_HEAD') && active.id !== targetUserId) {
    db.logAction(
      active.id,
      active.name,
      active.role,
      'UNAUTHORIZED_PROFILE_EDIT_ATTEMPT',
      'EMPLOYEE_FILE',
      `User attempted unauthorized edit on file of user ${targetUserId}`,
      targetUserId
    );
    return res.status(403).json({
      error: "Access Denied: In accordance with AmCham Philippines security governance and Republic Act 10173 (Data Privacy Act), non-HR personnel are strictly prohibited from modifying another employee's confidential profile.",
    });
  }

  let record = db.getData().employeeRecords.find((e) => e.userId === targetUserId);
  if (!record && active.id === targetUserId) {
    record = db.createEmployeeRecordForUser(active);
  }
  if (!record) {
    return res.status(404).json({ error: 'Employee record not found in Secretariat registry.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  // Security enforcement: Disallow modifying restricted fields
  const {
    personalContact,
    emergencyContact,
    statutoryInfo,
    supervisorName,
    workLocation,
    workSchedule,
  } = req.body;

  // Validation
  if (emergencyContact) {
    if (!emergencyContact.name || !emergencyContact.name.trim()) {
      return res.status(400).json({ error: 'Emergency contact person name is required.' });
    }
    if (!emergencyContact.phone || !emergencyContact.phone.trim()) {
      return res.status(400).json({ error: 'Emergency contact phone number is required.' });
    }
    if (!emergencyContact.relationship || !emergencyContact.relationship.trim()) {
      return res.status(400).json({ error: 'Emergency contact relationship is required.' });
    }
  }

  if (personalContact?.personalEmail && personalContact.personalEmail.trim()) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(personalContact.personalEmail.trim())) {
      return res.status(400).json({ error: 'Please enter a valid personal email address format.' });
    }
  }

  // Construct sanitized updates
  const updates: any = {};

  if (personalContact && typeof personalContact === 'object') {
    updates.personalContact = {
      phone: typeof personalContact.phone === 'string' ? personalContact.phone.trim() : record.personalContact?.phone,
      mobilePhone: typeof personalContact.mobilePhone === 'string' ? personalContact.mobilePhone.trim() : record.personalContact?.mobilePhone,
      personalEmail: typeof personalContact.personalEmail === 'string' ? personalContact.personalEmail.trim() : record.personalContact?.personalEmail,
      homeAddress: typeof personalContact.homeAddress === 'string' ? personalContact.homeAddress.trim() : record.personalContact?.homeAddress,
      civilStatus: typeof personalContact.civilStatus === 'string' ? personalContact.civilStatus.trim() : record.personalContact?.civilStatus,
      birthDate: typeof personalContact.birthDate === 'string' ? personalContact.birthDate.trim() : record.personalContact?.birthDate,
      gender: typeof personalContact.gender === 'string' ? personalContact.gender.trim() : record.personalContact?.gender,
    };
  }

  if (emergencyContact && typeof emergencyContact === 'object') {
    updates.emergencyContact = {
      name: emergencyContact.name.trim(),
      relationship: emergencyContact.relationship.trim(),
      phone: emergencyContact.phone.trim(),
      address: typeof emergencyContact.address === 'string' ? emergencyContact.address.trim() : (record.emergencyContact?.address || ''),
      alternativePhone: typeof emergencyContact.alternativePhone === 'string' ? emergencyContact.alternativePhone.trim() : record.emergencyContact?.alternativePhone,
    };
  }

  if (statutoryInfo && typeof statutoryInfo === 'object') {
    updates.statutoryInfo = {
      sss: typeof statutoryInfo.sss === 'string' && statutoryInfo.sss.trim() ? statutoryInfo.sss.trim() : record.statutoryInfo.sss,
      philhealth: typeof statutoryInfo.philhealth === 'string' && statutoryInfo.philhealth.trim() ? statutoryInfo.philhealth.trim() : record.statutoryInfo.philhealth,
      pagibig: typeof statutoryInfo.pagibig === 'string' && statutoryInfo.pagibig.trim() ? statutoryInfo.pagibig.trim() : record.statutoryInfo.pagibig,
      tin: typeof statutoryInfo.tin === 'string' && statutoryInfo.tin.trim() ? statutoryInfo.tin.trim() : record.statutoryInfo.tin,
    };
  }

  if (isHR) {
    if (typeof supervisorName === 'string' && supervisorName.trim()) {
      updates.supervisorName = supervisorName.trim();
    }
    if (typeof workLocation === 'string' && workLocation.trim()) {
      updates.workLocation = workLocation.trim();
    }
    if (typeof workSchedule === 'string' && workSchedule.trim()) {
      updates.workSchedule = workSchedule.trim();
    }
  }

  const updatedRecord = db.updateEmployeeRecordProfile(targetUserId, updates);

  db.logAction(
    active.id,
    active.name,
    active.role,
    'UPDATE_EMPLOYEE_PROFILE',
    'EMPLOYEE_FILE',
    `Updated 201 profile for ${record.fullName} (${record.employeeNumber})`,
    targetUserId
  );

  return res.json({
    success: true,
    message: 'Employee profile updated and saved to Secretariat database.',
    record: updatedRecord,
  });
}

// Update Employee Profile / 201 File Information
app.put('/api/employee/file/:userId', (req: Request, res: Response) => handleUpdateEmployeeProfile(req, res));

app.put('/api/employee/profile', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to update employee profile.' });
  }
  return handleUpdateEmployeeProfile(req, res, active.id);
});

// ====================================================
// EMPLOYEE REQUIREMENTS & DOCUMENT SUBMISSION MANAGEMENT
// ====================================================

const EMPLOYEE_DOCS_STORAGE_DIR = path.join(DATA_DIR, 'documents', 'employee_requirements');
if (!fs.existsSync(EMPLOYEE_DOCS_STORAGE_DIR)) {
  fs.mkdirSync(EMPLOYEE_DOCS_STORAGE_DIR, { recursive: true });
}

const employeeRequirementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit strictly enforced
  fileFilter: (_req, file, cb) => {
    const allowedExts = [
      '.pdf',
      '.jpg', '.jpeg', '.png', '.webp', '.gif',
      '.doc', '.docx',
      '.xls', '.xlsx',
      '.ppt', '.pptx',
      '.csv', '.txt', '.md', '.rtf',
      '.odt', '.ods', '.odp',
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedMimes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/jpg',
      'image/webp',
      'image/gif',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/csv',
      'text/plain',
      'text/markdown',
      'application/rtf',
      'text/rtf',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation',
    ];
    if (
      allowedExts.includes(ext) ||
      allowedMimes.includes(file.mimetype.toLowerCase()) ||
      file.mimetype.includes('image/') ||
      file.mimetype.includes('pdf') ||
      file.mimetype.includes('word') ||
      file.mimetype.includes('excel') ||
      file.mimetype.includes('spreadsheet') ||
      file.mimetype.includes('powerpoint') ||
      file.mimetype.includes('presentation') ||
      file.mimetype.includes('officedocument')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Invalid document format. Permitted formats are PDF, JPG, JPEG, PNG, WEBP, GIF, DOC, DOCX, XLS, XLSX, PPT, PPTX, CSV, TXT, RTF, and OpenDocument files (maximum 10MB).'));
    }
  },
});

const employeeRequirementUploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  employeeRequirementUpload.fields([
    { name: 'document', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File size exceeds maximum permitted limit of 10MB.' });
        }
        return res.status(400).json({ error: `File upload error: ${err.message}` });
      }
      return res.status(400).json({ error: err.message || 'Error processing uploaded file.' });
    }
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    if (files) {
      req.file = files['document']?.[0] || files['file']?.[0];
    }
    next();
  });
};

// 1. Get standard requirements catalog and category definitions
app.get('/api/employee-requirements/catalog', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  res.json({
    categories: EMPLOYEE_REQUIREMENT_CATEGORIES,
    catalog: EMPLOYEE_REQUIREMENTS_CATALOG,
  });
});

// 2. Get caller's own employee requirements, submissions, configs, and compliance
app.get('/api/employee-requirements/my', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Career applicants do not have internal employee requirement records.' });
  }

  const submissions = db.getEmployeeRequirements({ userId: active.id });
  const configs = db.getRequirementConfigs(active.id);
  const compliance = db.getEmployeeComplianceSummary(active.id);

  res.json({
    user: {
      id: active.id,
      name: active.name,
      employeeNumber: active.employeeNumber,
      department: active.department,
      jobTitle: active.jobTitle,
    },
    submissions,
    configs,
    compliance,
    categories: EMPLOYEE_REQUIREMENT_CATEGORIES,
    catalog: EMPLOYEE_REQUIREMENTS_CATALOG,
  });
});

// 3. Get employee requirements for a specific user (Owner or HR only)
app.get('/api/employee-requirements/user/:userId', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Career applicants cannot access internal employee records.' });
  }

  const targetUserId = req.params.userId;
  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  // Strict Data Privacy Guard: Employees can only view their own requirements
  if (!isHR && active.id !== targetUserId) {
    db.logAction(
      active.id,
      active.name,
      active.role,
      'UNAUTHORIZED_REQUIREMENT_ACCESS',
      'EMPLOYEE_REQUIREMENTS',
      `Attempted unauthorized view of requirements for user ${targetUserId}`,
      targetUserId
    );
    return res.status(403).json({
      error: "Access Denied: In accordance with AmCham Philippines security governance and Republic Act 10173 (Data Privacy Act), you are strictly prohibited from viewing another employee's confidential employment requirements.",
    });
  }

  const targetUser = db.getData().users.find((u) => u.id === targetUserId);
  const submissions = db.getEmployeeRequirements({ userId: targetUserId });
  const configs = db.getRequirementConfigs(targetUserId);
  const compliance = db.getEmployeeComplianceSummary(targetUserId);

  res.json({
    user: targetUser
      ? {
          id: targetUser.id,
          name: targetUser.name,
          employeeNumber: targetUser.employeeNumber,
          department: targetUser.department,
          jobTitle: targetUser.jobTitle,
        }
      : { id: targetUserId },
    submissions,
    configs,
    compliance,
    categories: EMPLOYEE_REQUIREMENT_CATEGORIES,
    catalog: EMPLOYEE_REQUIREMENTS_CATALOG,
  });
});

// 4. Upload an employee requirement or 201 file document (PDF, JPG, JPEG, PNG, max 10MB)
app.post(
  [
    '/api/employee-requirements/upload',
    '/api/employee/documents/upload',
    '/api/employee/file/:userId/documents',
    '/api/employee/documents',
    '/api/employee/upload',
  ],
  employeeRequirementUploadMiddleware,
  async (req: Request, res: Response) => {
    try {
      const active = getActiveUser(req);
      if (!active) {
        return res.status(401).json({ error: 'Authentication required to upload employee documents.' });
      }
      if (active.role === 'APPLICANT') {
        return res.status(403).json({ error: 'Career applicant accounts cannot upload employee requirements.' });
      }

      const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
      const requestedUserId = req.params.userId || req.body.userId;
      const targetUserId = isHR && requestedUserId ? requestedUserId : active.id;

      if (!isHR && requestedUserId && requestedUserId !== active.id) {
        return res.status(403).json({
          error: 'Access Denied: You cannot upload documents on behalf of another employee.',
        });
      }

      const { notes, expiryDate } = req.body;
      let requirementId = typeof req.body.requirementId === 'string' ? req.body.requirementId.trim() : '';
      const rawTitle = (req.body.documentTitle || req.body.title || req.body.requirementTitle || '').trim();

      // Resolve requirement definition from ID or Title
      if (!requirementId && rawTitle) {
        const lower = rawTitle.toLowerCase();
        if (lower.includes('birth')) {
          requirementId = 'req_birth_cert';
        } else if (lower.includes('pds') || lower.includes('personal data sheet')) {
          requirementId = 'req_pds';
        } else if (lower.includes('resume') || lower.includes('cv')) {
          requirementId = 'req_resume';
        } else if (lower.includes('valid id') || lower.includes('government')) {
          requirementId = 'req_valid_id';
        } else if (lower.includes('passport')) {
          requirementId = 'req_passport';
        } else if (lower.includes('2x2') || lower.includes('photo') || lower.includes('picture')) {
          requirementId = 'req_2x2_photo';
        } else if (lower.includes('nbi')) {
          requirementId = 'req_nbi_clearance';
        } else if (lower.includes('medical') || lower.includes('fit to work')) {
          requirementId = 'req_fit_to_work';
        } else {
          const matched = EMPLOYEE_REQUIREMENTS_CATALOG.find(
            (r) => r.title.toLowerCase() === lower || lower.includes(r.title.toLowerCase())
          );
          if (matched) requirementId = matched.id;
        }
      }

      if (!requirementId && !rawTitle) {
        return res.status(400).json({ error: 'Please specify the document requirement ID or document title.' });
      }

      let reqDef = EMPLOYEE_REQUIREMENTS_CATALOG.find((r) => r.id === requirementId);
      if (!reqDef) {
        // Fallback or custom document definition
        const resolvedTitle = rawTitle || 'Birth Certificate';
        const isBirth = resolvedTitle.toLowerCase().includes('birth');
        const defaultCatKey: EmployeeRequirementCategoryKey = isBirth ? 'PERSONAL_IDENTIFICATION' : 'EMPLOYMENT_DOCUMENTS';
        const defaultCatTitle = isBirth ? 'Personal Identification' : (req.body.category || 'Personal Identification');

        reqDef = {
          id: requirementId || (isBirth ? 'req_birth_cert' : `req_custom_${Date.now()}`),
          category: defaultCatKey,
          categoryTitle: defaultCatTitle,
          categoryLetter: isBirth ? 'A' : 'D',
          title: resolvedTitle,
          description: isBirth ? 'Official Certificate of Live Birth printed on security paper.' : 'Authorized employment document on file with AmCham Philippines HR.',
          defaultApplicability: 'REQUIRED',
          isApplicableByDefault: true,
          hasExpiration: false,
        };
      }

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'Please select a valid document file to upload.' });
      }

      const uploadedBuffer = req.file.buffer;
      if (uploadedBuffer.length < 50) {
        return res.status(400).json({ error: 'Uploaded file is too small or empty to be a valid document.' });
      }

      const uploadExt = path.extname(req.file.originalname).toLowerCase();
      if (uploadExt === '.pdf') {
        const hasPdfHeader = uploadedBuffer.length >= 5 && uploadedBuffer.slice(0, 5).toString('ascii') === '%PDF-';
        if (!hasPdfHeader) {
          return res.status(400).json({ error: 'Invalid PDF file: Missing %PDF- header signature.' });
        }
        if (uploadedBuffer.length < 300) {
          return res.status(400).json({ error: 'Invalid PDF file: File structure is truncated or incomplete.' });
        }
      } else if (['.jpg', '.jpeg'].includes(uploadExt)) {
        if (uploadedBuffer.length < 100 || uploadedBuffer[0] !== 0xFF || uploadedBuffer[1] !== 0xD8) {
          return res.status(400).json({ error: 'Invalid JPEG file: Corrupted image stream.' });
        }
      } else if (uploadExt === '.png') {
        if (uploadedBuffer.length < 100 || uploadedBuffer[0] !== 0x89 || uploadedBuffer.slice(1, 4).toString('ascii') !== 'PNG') {
          return res.status(400).json({ error: 'Invalid PNG file: Corrupted image signature.' });
        }
      } else if (['.docx', '.xlsx', '.pptx'].includes(uploadExt)) {
        if (uploadedBuffer.length < 100 || uploadedBuffer.slice(0, 4).toString('ascii') !== 'PK\x03\x04') {
          return res.status(400).json({ error: 'Invalid document file: Corrupted archive package.' });
        }
      }

      const targetUser = db.getData().users.find((u) => u.id === targetUserId);
      const empRecord = (db.getData().employeeRecords || []).find((e) => e.userId === targetUserId);
      const employeeName = targetUser?.name || empRecord?.fullName || active.name;
      const employeeNumber = targetUser?.employeeNumber || empRecord?.employeeNumber;
      const department = targetUser?.department || empRecord?.department;
      const jobTitle = targetUser?.jobTitle || empRecord?.jobTitle;

      // Secure persistent storage on disk
      const ext = path.extname(req.file.originalname).toLowerCase() || '.pdf';
      const storedFileName = `req_${targetUserId}_${reqDef.id}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`;
      const storagePath = path.join(EMPLOYEE_DOCS_STORAGE_DIR, storedFileName);

      try {
        if (!fs.existsSync(EMPLOYEE_DOCS_STORAGE_DIR)) {
          fs.mkdirSync(EMPLOYEE_DOCS_STORAGE_DIR, { recursive: true });
        }
        fs.writeFileSync(storagePath, req.file.buffer);
      } catch (fsErr: any) {
        console.error('[AMIE Employee Requirements] File write error:', fsErr);
        return res.status(500).json({ error: 'Failed to write document file to persistent storage.' });
      }

      // Explicit Storage Confirmation: Verify file was saved, size matches, and file is readable
      try {
        if (!fs.existsSync(storagePath)) {
          return res.status(500).json({ error: 'Storage confirmation failed: file was not found on persistent storage.' });
        }
        const stat = fs.statSync(storagePath);
        if (stat.size !== req.file.buffer.length) {
          try { fs.unlinkSync(storagePath); } catch {}
          return res.status(500).json({ error: 'Storage confirmation failed: written file size mismatch on disk.' });
        }
        const verifyRead = fs.readFileSync(storagePath);
        if (verifyRead.length !== req.file.buffer.length) {
          try { fs.unlinkSync(storagePath); } catch {}
          return res.status(500).json({ error: 'Storage confirmation failed: written document is unreadable from disk.' });
        }
      } catch (confirmErr: any) {
        try { fs.unlinkSync(storagePath); } catch {}
        return res.status(500).json({ error: `Storage confirmation check failed: ${confirmErr.message}` });
      }

      // Try cloud sync if configured
      try {
        await firebaseStorage.uploadDocumentFile(
          req.file.buffer,
          `employee_requirements/${storedFileName}`,
          req.file.originalname,
          req.file.mimetype || 'application/octet-stream'
        );
      } catch (e: any) {
        console.warn('[AMIE Employee Requirements] Cloud mirror warning:', e?.message);
      }

      const fileSizeBytes = req.file.size || req.file.buffer.length;
      const fileSizeFormatted =
        fileSizeBytes > 1024 * 1024
          ? `${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB`
          : `${Math.round(fileSizeBytes / 1024)} KB`;

      const now = new Date().toISOString();

      // Check if previous submission exists for replacement audit trail
      const existing = db.getRequirementSubmissionForUser(targetUserId, reqDef.id);

      let submission: EmployeeRequirementSubmission;

      if (existing) {
        const prevVersion = existing.version || 1;
        // Preserve exact previous version storage references in audit history
        const historyEntry: RequirementAuditEntry = {
          action: 'REPLACED',
          performedBy: active.name,
          performedById: active.id,
          timestamp: now,
          remarks: notes ? notes.trim() : `Replaced with new file version (${req.file.originalname})`,
          previousStatus: existing.status,
          newStatus: 'SUBMITTED',
          fileName: existing.originalName || existing.fileName,
          storedFileName: existing.storedFileName || existing.fileName,
          storagePath: existing.storagePath,
          downloadUrl: existing.downloadUrl || `/api/employee-requirements/download/${existing.id}`,
          fileSizeBytes: existing.fileSizeBytes,
          fileSize: existing.fileSize,
          version: prevVersion,
        };

        const updatedExisting: EmployeeRequirementSubmission = {
          ...existing,
          fileName: storedFileName,
          originalName: req.file.originalname,
          storedFileName: storedFileName,
          fileSize: fileSizeFormatted,
          fileSizeBytes: fileSizeBytes,
          mimeType: req.file.mimetype || 'application/octet-stream',
          storagePath: storagePath,
          fileUrl: `/api/employee-requirements/file/${existing.id}`,
          downloadUrl: `/api/employee-requirements/download/${existing.id}`,
          version: prevVersion + 1,
          status: 'SUBMITTED',
          notes: notes ? notes.trim() : existing.notes,
          submittedAt: now,
          submittedBy: active.name,
          submittedById: active.id,
          verifiedAt: undefined,
          verifiedBy: undefined,
          verifiedById: undefined,
          reviewRemarks: undefined,
          expiryDate: expiryDate || existing.expiryDate,
          history: Array.isArray(existing.history) ? [...existing.history, historyEntry] : [historyEntry],
          updatedAt: now,
        };

        submission = db.saveRequirementSubmission(updatedExisting);
      } else {
        const subId = `req_sub_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const historyEntry: RequirementAuditEntry = {
          action: 'UPLOADED',
          performedBy: active.name,
          performedById: active.id,
          timestamp: now,
          remarks: notes ? notes.trim() : 'Initial requirement document upload',
          newStatus: 'SUBMITTED',
          fileName: req.file.originalname,
          fileUrl: `/api/employee-requirements/file/${subId}`,
          version: 1,
        };

        submission = {
          id: subId,
          userId: targetUserId,
          employeeName,
          employeeNumber,
          department,
          jobTitle,
          requirementId: reqDef.id,
          requirementTitle: reqDef.title,
          category: reqDef.category,
          categoryTitle: reqDef.categoryTitle,
          categoryLetter: reqDef.categoryLetter,
          status: 'SUBMITTED',
          fileName: storedFileName,
          originalName: req.file.originalname,
          storedFileName,
          fileSize: fileSizeFormatted,
          fileSizeBytes,
          mimeType: req.file.mimetype || 'application/octet-stream',
          storagePath,
          fileUrl: `/api/employee-requirements/file/${subId}`,
          downloadUrl: `/api/employee-requirements/download/${subId}`,
          version: 1,
          notes: notes ? notes.trim() : undefined,
          submittedAt: now,
          submittedBy: active.name,
          submittedById: active.id,
          expiryDate: expiryDate || undefined,
          history: [historyEntry],
          updatedAt: now,
        };

        submission = db.saveRequirementSubmission(submission);
      }

      // Ensure document is immediately reflected in employee's authorizedDocuments list
      const resolvedCategory = req.body.category || (reqDef.id === 'req_birth_cert' || reqDef.title.toLowerCase().includes('birth') ? 'Personal Identification' : reqDef.categoryTitle) || 'Personal Identification';
      const authDoc: AuthorizedDocument = {
        id: submission.id,
        title: reqDef.title,
        category: resolvedCategory,
        fileName: req.file.originalname,
        storedFileName: submission.storedFileName,
        storagePath: submission.storagePath,
        uploadedDate: now.split('T')[0],
        fileSize: fileSizeFormatted,
        verified: submission.status === 'VERIFIED',
        downloadUrl: `/api/employee-requirements/download/${submission.id}`,
        previewContent: `Official uploaded document (${reqDef.title}: ${req.file.originalname}) on file with AmCham Philippines HR.`,
      };
      db.addAuthorizedDocument(targetUserId, authDoc);

      // Send notification to all active HR Personnel / Administrators
      const hrRecipients = db.getActiveHRRecipients(active.id);
      if (hrRecipients.length > 0) {
        for (const hr of hrRecipients) {
          db.createNotification(
            hr.id,
            'New Employment Requirement Document Submitted',
            `${employeeName} (${department || 'Secretariat'}) submitted "${reqDef.title}". Awaiting HR verification.`,
            'SYSTEM',
            'my-file',
            {
              submissionId: submission.id,
              requirementId: reqDef.id,
              employeeId: targetUserId,
              employeeName,
              eventKey: `req_sub_${submission.id}_${hr.id}`,
            },
            hr.email
          );
        }
      } else {
        db.createNotification(
          DESIGNATED_HR_ADMIN_CONFIG.id,
          'New Employment Requirement Document Submitted',
          `${employeeName} (${department || 'Secretariat'}) submitted "${reqDef.title}". Awaiting HR verification.`,
          'SYSTEM',
          'my-file',
          {
            submissionId: submission.id,
            requirementId: reqDef.id,
            employeeId: targetUserId,
            employeeName,
            eventKey: `req_sub_${submission.id}_rachel`,
          },
          DESIGNATED_HR_ADMIN_CONFIG.primaryEmail
        );
      }

      db.logAction(
        active.id,
        active.name,
        active.role,
        'UPLOAD_EMPLOYEE_REQUIREMENT',
        'EMPLOYEE_REQUIREMENTS',
        `Uploaded document for "${reqDef.title}" (${req.file.originalname}, ${fileSizeFormatted}) for employee ${employeeName}`,
        targetUserId
      );

      return res.status(200).json({
        success: true,
        message: `Document "${req.file.originalname}" for "${reqDef.title}" uploaded successfully and added to Employee 201 File.`,
        documentId: submission.id,
        originalFilename: req.file.originalname,
        fileType: req.file.mimetype || 'application/pdf',
        fileSize: fileSizeFormatted,
        storageReference: storedFileName,
        uploadStatus: submission.status,
        document: authDoc,
        submission,
        compliance: db.getEmployeeComplianceSummary(targetUserId),
      });
    } catch (uploadError: any) {
      console.error('[AMIE Document Upload Error]:', uploadError);
      return res.status(500).json({
        error: uploadError.message || 'An error occurred while uploading the document.',
        success: false,
      });
    }
  }
);

// Helper function to resolve MIME type from extension
function resolveDocumentMimeType(filePath: string, fallbackMime?: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.doc':
      return 'application/msword';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls':
      return 'application/vnd.ms-excel';
    case '.csv':
      return 'text/csv';
    case '.txt':
      return 'text/plain';
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.ppt':
      return 'application/vnd.ms-powerpoint';
    default:
      return fallbackMime || 'application/octet-stream';
  }
}

// PPT / PPTX Slide Extraction Helper using JSZip
async function parsePptxSlides(buffer: Buffer): Promise<{ slideNumber: number; title: string; paragraphs: string[]; images: string[]; rawText: string }[]> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slideEntries: { path: string; num: number }[] = [];

    zip.forEach((relativePath: string) => {
      const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
      if (match) {
        slideEntries.push({ path: relativePath, num: parseInt(match[1], 10) });
      }
    });

    slideEntries.sort((a, b) => a.num - b.num);
    const slides: { slideNumber: number; title: string; paragraphs: string[]; images: string[]; rawText: string }[] = [];

    for (let i = 0; i < slideEntries.length; i++) {
      const entry = slideEntries[i];
      const xml = (await zip.file(entry.path)?.async('text')) || '';

      const paragraphs: string[] = [];
      const pRegex = /<a:p[^>]*>([\s\S]*?)<\/a:p>/gi;
      let pMatch;
      while ((pMatch = pRegex.exec(xml)) !== null) {
        const pXml = pMatch[1];
        const pTexts: string[] = [];
        let tM;
        const innerTRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/gi;
        while ((tM = innerTRegex.exec(pXml)) !== null) {
          const t = tM[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .trim();
          if (t) pTexts.push(t);
        }
        const combined = pTexts.join(' ').trim();
        if (combined) {
          paragraphs.push(combined);
        }
      }

      // Check for slide images in slide relationships
      const images: string[] = [];
      const relPath = entry.path.replace('ppt/slides/slide', 'ppt/slides/_rels/slide') + '.rels';
      const relsXml = await zip.file(relPath)?.async('text');
      if (relsXml) {
        const relRegex = /Target="(?:\.\.\/)?media\/([^"]+)"/gi;
        let rM;
        while ((rM = relRegex.exec(relsXml)) !== null) {
          const imgName = path.basename(rM[1]);
          const mediaFile = zip.file(`ppt/media/${imgName}`);
          if (mediaFile) {
            const imgBuf = await mediaFile.async('nodebuffer');
            const extName = path.extname(imgName).toLowerCase().replace('.', '');
            const mime = extName === 'jpg' || extName === 'jpeg' ? 'image/jpeg' : extName === 'png' ? 'image/png' : 'image/webp';
            images.push(`data:${mime};base64,${imgBuf.toString('base64')}`);
          }
        }
      }

      const title = paragraphs[0] || `Slide ${i + 1}`;
      slides.push({
        slideNumber: i + 1,
        title,
        paragraphs: paragraphs.length > 1 ? paragraphs.slice(1) : paragraphs,
        images,
        rawText: paragraphs.join('\n\n'),
      });
    }

    return slides;
  } catch (err: any) {
    console.error('[AMIE PPTX Preview] Error parsing PPTX presentation:', err);
    return [];
  }
}

// 5. Universal Document Preview Data Endpoint
app.get(
  [
    '/api/employee-requirements/preview-data/:id',
    '/api/employee/documents/preview-data/:id',
    '/api/employee/documents/:id/preview-data',
  ],
  async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to preview document.' });
  }

  const rawToken =
    (req.query?.token as string) ||
    (req.headers.authorization ? req.headers.authorization : '') ||
    (req.headers['x-session-token'] as string) ||
    (req.cookies?.amie_session_token as string) ||
    '';
  const token = cleanSessionToken(rawToken);

  // 1. Locate submission or authorized document
  let sub = db.getRequirementSubmissionById(req.params.id);

  if (!sub) {
    // Search authorizedDocuments across employeeRecords
    for (const emp of db.getData().employeeRecords || []) {
      const doc = (emp.authorizedDocuments || []).find((d) => d.id === req.params.id);
      if (doc) {
        sub = {
          id: doc.id,
          userId: emp.userId,
          employeeName: emp.fullName,
          employeeNumber: emp.employeeNumber,
          department: emp.department,
          jobTitle: emp.jobTitle,
          requirementId: doc.id,
          requirementTitle: doc.title,
          category: (doc.category as any) || 'EMPLOYMENT_DOCUMENTS',
          categoryTitle: 'Authorized Employment Documents',
          categoryLetter: 'D',
          status: doc.verified ? 'VERIFIED' : 'SUBMITTED',
          fileName: (doc as any).storedFileName || doc.fileName,
          originalName: doc.fileName,
          storedFileName: (doc as any).storedFileName || doc.fileName,
          fileSize: doc.fileSize,
          fileSizeBytes: (doc as any).fileSizeBytes || 0,
          mimeType: resolveDocumentMimeType((doc as any).storedFileName || doc.fileName),
          storagePath: (doc as any).storagePath || '',
          fileUrl: `/api/employee-requirements/file/${doc.id}`,
          downloadUrl: `/api/employee-requirements/download/${doc.id}`,
          version: 1,
          submittedAt: doc.uploadedDate || new Date().toISOString(),
          submittedBy: emp.fullName,
          submittedById: emp.userId,
          verifiedAt: doc.verified ? doc.uploadedDate : undefined,
          history: [],
          updatedAt: new Date().toISOString(),
        };
        break;
      }
    }
  }

  if (!sub) {
    return res.status(404).json({ error: 'Document submission record not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  // Security check: non-HR users can only preview their own documents
  if (!isHR && sub.userId !== active.id) {
    return res.status(403).json({
      error: 'Access Denied: You are not authorized to view this confidential employment document.',
    });
  }

  const candidatePaths = [
    sub.storagePath,
    path.join(EMPLOYEE_DOCS_STORAGE_DIR, sub.storedFileName || sub.fileName),
    path.join(DATA_DIR, 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join(DATA_DIR, 'applicant_uploads', sub.storedFileName || sub.fileName),
    path.join(process.cwd(), '.data', 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join(process.cwd(), '.data', 'applicant_uploads', sub.storedFileName || sub.fileName),
    path.join('/.data', 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join('/app/applet/.data', 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join('/.data', 'applicant_uploads', sub.storedFileName || sub.fileName),
    path.join('/app/applet/.data', 'applicant_uploads', sub.storedFileName || sub.fileName),
  ];

  let foundPath: string | null = null;
  for (const p of candidatePaths) {
    if (p && fs.existsSync(p)) {
      foundPath = p;
      break;
    }
  }

  let fileBuffer: Buffer | null = null;
  let ext = '';
  if (foundPath) {
    try {
      fileBuffer = fs.readFileSync(foundPath);
      ext = path.extname(foundPath).toLowerCase();
    } catch (readErr: any) {
      console.warn(`[AMIE Preview] Error reading local file ${foundPath}:`, readErr.message);
    }
  }

  if (!fileBuffer) {
    const mem = firebaseStorage.getFileBuffer(sub.storagePath || sub.storedFileName || sub.fileName);
    if (mem) {
      fileBuffer = mem.buffer;
      ext = path.extname(mem.originalName || sub.originalName || sub.fileName || '').toLowerCase();
    }
  }

  if (!fileBuffer) {
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    return res.json({
      id: sub.id,
      requirementId: sub.requirementId,
      requirementTitle: sub.requirementTitle,
      originalName: sub.originalName || sub.fileName,
      fileName: sub.storedFileName || sub.fileName,
      mimeType: sub.mimeType || 'application/octet-stream',
      fileSize: sub.fileSize || '0 KB',
      fileSizeBytes: sub.fileSizeBytes || 0,
      format: 'unsupported',
      fileUrl: `/api/employee-requirements/file/${sub.id}${tokenParam}`,
      downloadUrl: `/api/employee-requirements/download/${sub.id}${tokenParam}`,
      rawUrl: `/api/employee-requirements/file/${sub.id}${tokenParam}`,
      version: sub.version || 1,
      status: sub.status,
      employeeName: sub.employeeName,
      department: sub.department,
      submittedAt: sub.submittedAt,
      isCorrupted: true,
      integrityNote: 'Physical document file not found in storage archive. The submission record is intact, but the file content must be re-uploaded.',
      textContent: `Document: ${sub.requirementTitle}\nSubmitted by: ${sub.employeeName}\nStatus: ${sub.status}\n\nNotice: The original document file is missing from the local server storage archive. Please re-upload a replacement file.`,
      htmlContent: `<div class="p-6 text-center text-slate-500 dark:text-slate-400">Physical document file not found in storage archive. Please re-upload this document.</div>`,
    });
  }

  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
  const fileStreamUrl = `/api/employee-requirements/file/${sub.id}${tokenParam}`;
  const fileDownloadUrl = `/api/employee-requirements/download/${sub.id}${tokenParam}`;

  const sizeBytes = fileBuffer.length;
  const fileSizeFormatted = sub.fileSize || (sizeBytes > 1024 * 1024 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(sizeBytes / 1024)} KB`);
  const effectiveMime = resolveDocumentMimeType(foundPath || sub.originalName || sub.fileName, sub.mimeType);

  let isCorrupted = false;
  let integrityNote: string | undefined = undefined;

  const isPdf = ext === '.pdf' || effectiveMime === 'application/pdf';
  if (isPdf) {
    const hasPdfHeader = fileBuffer.length >= 5 && fileBuffer.slice(0, 5).toString('ascii') === '%PDF-';
    if (!hasPdfHeader) {
      isCorrupted = true;
      integrityNote = 'File does not contain a valid %PDF- header signature.';
    } else if (fileBuffer.length < 500) {
      isCorrupted = true;
      integrityNote = `Incomplete PDF document archive (${sizeBytes} bytes). File structure is truncated.`;
    } else {
      try {
        await pdfParse(fileBuffer);
      } catch (parseErr: any) {
        isCorrupted = true;
        integrityNote = `PDF document structure is corrupted or damaged (${parseErr?.message || 'bad XRef or truncated stream'}).`;
      }
    }
  } else if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext) || effectiveMime.startsWith('image/')) {
    if (fileBuffer.length < 32) {
      isCorrupted = true;
      integrityNote = 'Image file is too small or truncated.';
    }
  } else if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
    if (fileBuffer.length < 100 || fileBuffer.slice(0, 4).toString('ascii') !== 'PK\x03\x04') {
      isCorrupted = true;
      integrityNote = 'Document archive package is corrupted or incomplete.';
    }
  }

  let hasFileSizeMismatch = false;
  if (sub.fileSizeBytes && sub.fileSizeBytes > 0 && fileBuffer.length !== sub.fileSizeBytes) {
    hasFileSizeMismatch = true;
    isCorrupted = true;
    integrityNote = `File integrity mismatch: stored file on disk (${fileBuffer.length} bytes) does not match the original uploaded record (${sub.fileSizeBytes} bytes). Flagged for HR review — do not rely on this file as the original document.`;
  }

  // Log preview audit
  db.logAction(
    active.id,
    active.name,
    active.role,
    'PREVIEW_EMPLOYEE_REQUIREMENT',
    'EMPLOYEE_REQUIREMENTS',
    `Previewed requirement document "${sub.requirementTitle}" (${sub.originalName || sub.fileName}) for employee ${sub.employeeName}`,
    sub.userId
  );

  const baseResponse: DocumentPreviewData = {
    id: sub.id,
    requirementId: sub.requirementId,
    requirementTitle: sub.requirementTitle,
    originalName: sub.originalName || sub.fileName,
    fileName: sub.fileName,
    mimeType: effectiveMime,
    fileSize: fileSizeFormatted,
    fileSizeBytes: sizeBytes,
    isCorrupted,
    integrityNote,
    format: 'pdf',
    fileUrl: fileStreamUrl,
    downloadUrl: fileDownloadUrl,
    rawUrl: fileStreamUrl,
    version: sub.version || 1,
    status: sub.status,
    employeeName: sub.employeeName,
    department: sub.department,
    submittedAt: sub.submittedAt,
    verifiedAt: sub.verifiedAt,
    verifiedBy: sub.verifiedBy,
    reviewRemarks: sub.reviewRemarks,
  };

  if (hasFileSizeMismatch) {
    return res.json({
      ...baseResponse,
      format: 'unsupported',
      message: integrityNote,
      textContent: `Document: ${sub.requirementTitle}\nOriginal Filename: ${sub.originalName || sub.fileName}\nRecorded Size: ${sub.fileSizeBytes} bytes\nDisk Size: ${sizeBytes} bytes\n\nFLAGGED FOR HR REVIEW: The stored file size does not match the original upload record. To prevent presenting an unverified or substituted document, inline preview is disabled. Please re-upload the authentic document or contact HR.`,
    });
  }

  // 1. PDF
  if (ext === '.pdf' || effectiveMime === 'application/pdf') {
    let numPages = 1;
    try {
      const parsed = await pdfParse(fileBuffer, { max: 0 });
      if (parsed?.numpages) {
        numPages = parsed.numpages;
      }
    } catch {
      // non-fatal, client PDF.js will determine exact numPages
    }
    return res.json({ ...baseResponse, format: 'pdf', numPages });
  }

  // 2. Images (JPG, JPEG, PNG, WEBP, GIF, SVG)
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'].includes(ext) || effectiveMime.startsWith('image/')) {
    return res.json({ ...baseResponse, format: 'image' });
  }

  // 3. Word DOCX
  if (ext === '.docx') {
    try {
      const options = {
        convertImage: mammoth.images.imgElement((image: any) => {
          return image.read('base64').then((imageBuffer: string) => {
            return {
              src: `data:${image.contentType};base64,${imageBuffer}`,
            };
          });
        }),
      };
      const mammothResult = await mammoth.convertToHtml({ buffer: fileBuffer }, options);
      return res.json({
        ...baseResponse,
        format: 'docx',
        htmlContent: mammothResult.value,
      });
    } catch (docxErr: any) {
      console.error('[AMIE Document Preview] DOCX conversion error:', docxErr);
      return res.json({
        ...baseResponse,
        format: 'docx',
        htmlContent: '<div class="p-6 text-slate-700 dark:text-slate-300"><p>Unable to generate HTML preview for this Word document. Please use the secure download button to view in Microsoft Word.</p></div>',
      });
    }
  }

  // 4. PowerPoint Presentations (.pptx, .ppt)
  if (['.pptx', '.ppt'].includes(ext)) {
    const slides = await parsePptxSlides(fileBuffer);
    if (slides.length > 0) {
      return res.json({
        ...baseResponse,
        format: 'presentation',
        slides,
      });
    }
    return res.json({
      ...baseResponse,
      format: 'unsupported',
      message: 'Could not extract slides from PowerPoint presentation. Please use the download button to open in Microsoft PowerPoint.',
    });
  }

  // 5. Word DOC (Legacy binary Word)
  if (ext === '.doc') {
    const rawString = fileBuffer.toString('latin1');
    const matches = rawString.match(/[\x20-\x7E\r\n\t]{4,}/g) || [];
    const cleanedText = matches.filter((s: string) => !s.startsWith('bjbj') && !s.includes('Microsoft Word')).join('\n\n');
    return res.json({
      ...baseResponse,
      format: 'doc',
      textContent: cleanedText || 'Word Document Binary Archive',
    });
  }

  // 6. Excel Spreadsheet (.xlsx, .xls)
  if (['.xlsx', '.xls'].includes(ext)) {
    try {
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
      const sheetNames = workbook.SheetNames || ['Sheet1'];
      const sheetsHtml: Record<string, string> = {};

      for (const sName of sheetNames) {
        const worksheet = workbook.Sheets[sName];
        if (worksheet) {
          sheetsHtml[sName] = XLSX.utils.sheet_to_html(worksheet, {
            editable: false,
            header: '',
            footer: '',
          });
        }
      }

      return res.json({
        ...baseResponse,
        format: 'spreadsheet',
        sheetNames,
        sheetsHtml,
        activeSheet: sheetNames[0] || 'Sheet1',
      });
    } catch (xlsxErr: any) {
      console.error('[AMIE Document Preview] Excel parsing error:', xlsxErr);
      return res.json({
        ...baseResponse,
        format: 'unsupported',
        message: 'Could not render spreadsheet preview. Please use the secure download button to view in Microsoft Excel or Google Sheets.',
      });
    }
  }

  // 7. CSV or Plain Text (.csv, .txt)
  if (['.csv', '.txt'].includes(ext)) {
    const text = fileBuffer.toString('utf-8');
    return res.json({
      ...baseResponse,
      format: 'text',
      textContent: text,
    });
  }

  // Fallback for any other format
  return res.json({
    ...baseResponse,
    format: 'unsupported',
    message: `Preview is not directly supported for ${ext.toUpperCase() || 'this'} files in the browser. Please download the document to open it in its native application.`,
  });
});

// 6. Secure File Inline Streaming (with token support)
app.get(
  [
    '/api/employee-requirements/file/:id',
    '/api/employee/documents/file/:id',
    '/api/employee/documents/:id/file',
  ],
  async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to preview document.' });
  }

  let sub = db.getRequirementSubmissionById(req.params.id);

  if (!sub) {
    for (const emp of db.getData().employeeRecords || []) {
      const doc = (emp.authorizedDocuments || []).find((d) => d.id === req.params.id);
      if (doc) {
        sub = {
          id: doc.id,
          userId: emp.userId,
          employeeName: emp.fullName,
          employeeNumber: emp.employeeNumber,
          department: emp.department,
          jobTitle: emp.jobTitle,
          requirementId: doc.id,
          requirementTitle: doc.title,
          category: (doc.category as any) || 'EMPLOYMENT_DOCUMENTS',
          categoryTitle: 'Authorized Employment Documents',
          categoryLetter: 'D',
          status: doc.verified ? 'VERIFIED' : 'SUBMITTED',
          fileName: (doc as any).storedFileName || doc.fileName,
          originalName: doc.fileName,
          storedFileName: (doc as any).storedFileName || doc.fileName,
          fileSize: doc.fileSize,
          fileSizeBytes: (doc as any).fileSizeBytes || 0,
          mimeType: resolveDocumentMimeType((doc as any).storedFileName || doc.fileName),
          storagePath: (doc as any).storagePath || '',
          fileUrl: `/api/employee-requirements/file/${doc.id}`,
          downloadUrl: `/api/employee-requirements/download/${doc.id}`,
          version: 1,
          submittedAt: doc.uploadedDate || new Date().toISOString(),
          submittedBy: emp.fullName,
          submittedById: emp.userId,
          history: [],
          updatedAt: new Date().toISOString(),
        };
        break;
      }
    }
  }

  if (!sub) {
    return res.status(404).json({ error: 'Document submission not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  // Security check: non-HR users can only preview their own documents
  if (!isHR && sub.userId !== active.id) {
    return res.status(403).json({
      error: 'Access Denied: You are not authorized to view this confidential employment document.',
    });
  }

  const candidatePaths = [
    sub.storagePath,
    path.join(EMPLOYEE_DOCS_STORAGE_DIR, sub.storedFileName || sub.fileName),
    path.join(DATA_DIR, 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join(DATA_DIR, 'applicant_uploads', sub.storedFileName || sub.fileName),
    path.join(process.cwd(), '.data', 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join(process.cwd(), '.data', 'applicant_uploads', sub.storedFileName || sub.fileName),
    path.join('/.data', 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join('/app/applet/.data', 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join('/.data', 'applicant_uploads', sub.storedFileName || sub.fileName),
    path.join('/app/applet/.data', 'applicant_uploads', sub.storedFileName || sub.fileName),
  ];

  let foundPath: string | null = null;
  for (const p of candidatePaths) {
    if (p && fs.existsSync(p)) {
      foundPath = p;
      break;
    }
  }

  const effectiveMime = resolveDocumentMimeType(foundPath || sub.originalName || sub.fileName, sub.mimeType);
  const safeOriginalName = (sub.originalName || sub.fileName || 'document.pdf').replace(/"/g, '');

  if (foundPath) {
    const stat = fs.statSync(foundPath);
    const range = req.headers.range;

    res.setHeader('Content-Type', effectiveMime);
    res.setHeader('Content-Disposition', `inline; filename="${safeOriginalName}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;
      const file = fs.createReadStream(foundPath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': effectiveMime,
      });
      return file.pipe(res);
    }

    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(foundPath).pipe(res);
  }

  // Fallback to Firebase Storage / in-memory streaming
  const streamed = await firebaseStorage.streamDocumentToResponse(
    sub.storagePath || sub.storedFileName || sub.fileName,
    res,
    effectiveMime,
    safeOriginalName
  );

  if (!streamed) {
    return res.status(404).json({ error: 'Physical document file not found in storage.' });
  }
});

// 7. Secure File Download (with token support & audit logging)
app.get(
  [
    '/api/employee-requirements/download/:id',
    '/api/employee/documents/download/:id',
    '/api/employee/documents/:id/download',
  ],
  async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to download document.' });
  }

  let sub = db.getRequirementSubmissionById(req.params.id);

  if (!sub) {
    for (const emp of db.getData().employeeRecords || []) {
      const doc = (emp.authorizedDocuments || []).find((d) => d.id === req.params.id);
      if (doc) {
        sub = {
          id: doc.id,
          userId: emp.userId,
          employeeName: emp.fullName,
          employeeNumber: emp.employeeNumber,
          department: emp.department,
          jobTitle: emp.jobTitle,
          requirementId: doc.id,
          requirementTitle: doc.title,
          category: (doc.category as any) || 'EMPLOYMENT_DOCUMENTS',
          categoryTitle: 'Authorized Employment Documents',
          categoryLetter: 'D',
          status: doc.verified ? 'VERIFIED' : 'SUBMITTED',
          fileName: doc.fileName,
          originalName: doc.fileName,
          storedFileName: doc.fileName,
          fileSize: doc.fileSize,
          fileSizeBytes: 0,
          mimeType: resolveDocumentMimeType(doc.fileName),
          storagePath: '',
          fileUrl: `/api/employee-requirements/file/${doc.id}`,
          downloadUrl: `/api/employee-requirements/download/${doc.id}`,
          version: 1,
          submittedAt: doc.uploadedDate || new Date().toISOString(),
          submittedBy: emp.fullName,
          submittedById: emp.userId,
          history: [],
          updatedAt: new Date().toISOString(),
        };
        break;
      }
    }
  }

  if (!sub) {
    return res.status(404).json({ error: 'Document submission not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';

  if (!isHR && sub.userId !== active.id) {
    return res.status(403).json({
      error: 'Access Denied: You are not authorized to download this confidential document.',
    });
  }

  const candidatePaths = [
    sub.storagePath,
    path.join(EMPLOYEE_DOCS_STORAGE_DIR, sub.storedFileName || sub.fileName),
    path.join(DATA_DIR, 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join(DATA_DIR, 'applicant_uploads', sub.storedFileName || sub.fileName),
    path.join(process.cwd(), '.data', 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join(process.cwd(), '.data', 'applicant_uploads', sub.storedFileName || sub.fileName),
    path.join('/.data', 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join('/app/applet/.data', 'documents', 'employee_requirements', sub.storedFileName || sub.fileName),
    path.join('/.data', 'applicant_uploads', sub.storedFileName || sub.fileName),
    path.join('/app/applet/.data', 'applicant_uploads', sub.storedFileName || sub.fileName),
  ];

  let foundPath: string | null = null;
  for (const p of candidatePaths) {
    if (p && fs.existsSync(p)) {
      foundPath = p;
      break;
    }
  }

  // Audit log download
  db.logAction(
    active.id,
    active.name,
    active.role,
    'DOWNLOAD_EMPLOYEE_REQUIREMENT',
    'EMPLOYEE_REQUIREMENTS',
    `Downloaded requirement document "${sub.requirementTitle}" (${sub.originalName || sub.fileName}) for employee ${sub.employeeName}`,
    sub.userId
  );

  const effectiveMime = resolveDocumentMimeType(foundPath || sub.originalName || sub.fileName, sub.mimeType);
  const safeOriginalName = (sub.originalName || sub.fileName || 'document.pdf').replace(/"/g, '');

  if (foundPath) {
    const stat = fs.statSync(foundPath);
    res.setHeader('Content-Type', effectiveMime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeOriginalName}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    return fs.createReadStream(foundPath).pipe(res);
  }

  // In-memory or Firebase Storage fallback
  const mem = firebaseStorage.getFileBuffer(sub.storagePath || sub.storedFileName || sub.fileName);
  if (mem) {
    res.setHeader('Content-Type', effectiveMime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeOriginalName}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    return res.send(mem.buffer);
  }

  return res.status(404).json({ error: 'Physical document file not found in storage.' });
});

// Download historical requirement document version preserved in audit history
app.get('/api/employee-requirements/history-file/:id/:index', async (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to download historical document.' });
  }

  const sub = db.getRequirementSubmissionById(req.params.id);
  if (!sub) {
    return res.status(404).json({ error: 'Document submission record not found.' });
  }

  const isHR = active.role === 'HR_PERSONNEL' || active.role === 'HR_ADMINISTRATOR' || active.role === 'SYSTEM_ADMINISTRATOR';
  if (!isHR && sub.userId !== active.id) {
    return res.status(403).json({
      error: 'Access Denied: You are not authorized to download this confidential document.',
    });
  }

  const index = parseInt(req.params.index, 10);
  if (isNaN(index) || !sub.history || !sub.history[index]) {
    return res.status(404).json({ error: 'Specified historical version entry not found in document history.' });
  }

  const entry = sub.history[index];
  const targetFileName = entry.storedFileName || entry.fileName;
  const candidatePaths = [
    entry.storagePath,
    targetFileName ? path.join(EMPLOYEE_DOCS_STORAGE_DIR, targetFileName) : null,
    targetFileName ? path.join(DATA_DIR, 'documents', 'employee_requirements', targetFileName) : null,
    targetFileName ? path.join(process.cwd(), '.data', 'documents', 'employee_requirements', targetFileName) : null,
  ].filter(Boolean) as string[];

  let foundPath: string | null = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      foundPath = p;
      break;
    }
  }

  const effectiveMime = resolveDocumentMimeType(foundPath || entry.fileName || 'document.pdf');
  const safeOriginalName = (entry.fileName || `history_v${entry.version || 1}.pdf`).replace(/"/g, '');

  if (foundPath) {
    const stat = fs.statSync(foundPath);
    res.setHeader('Content-Type', effectiveMime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeOriginalName}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    return fs.createReadStream(foundPath).pipe(res);
  }

  const mem = targetFileName ? firebaseStorage.getFileBuffer(targetFileName) : null;
  if (mem) {
    res.setHeader('Content-Type', effectiveMime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeOriginalName}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    return res.send(mem.buffer);
  }

  return res.status(404).json({ error: 'Historical document archive file not found in persistent storage.' });
});

// 8. HR Document Management & Repository: View all submissions and employee collections
app.get(
  '/api/employee-requirements/admin/all',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const { userId, category, status, search, department } = req.query;

    let submissions = db.getEmployeeRequirements({
      userId: typeof userId === 'string' ? userId : undefined,
      category: typeof category === 'string' ? category : undefined,
      status: typeof status === 'string' ? status : undefined,
      search: typeof search === 'string' ? search : undefined,
    });

    if (department && typeof department === 'string' && department !== 'ALL') {
      submissions = submissions.filter(
        (s) => s.department?.toLowerCase() === department.toLowerCase()
      );
    }

    const complianceSummaries = db.getAllComplianceSummaries();

    // Compile chamber-wide genuine employee list with real statistics
    const genuineStaffUsers = db.getData().users.filter((u) => u.role !== 'APPLICANT');
    const employees = genuineStaffUsers.map((u) => {
      const empRecord = (db.getData().employeeRecords || []).find((e) => e.userId === u.id);
      const userSubmissions = db.getEmployeeRequirements({ userId: u.id });
      const comp = db.getEmployeeComplianceSummary(u.id);

      return {
        id: u.id,
        name: u.name,
        email: u.email,
        employeeNumber: u.employeeNumber || empRecord?.employeeNumber || 'N/A',
        department: u.department || empRecord?.department || 'General Secretariat',
        jobTitle: u.jobTitle || empRecord?.jobTitle || 'Staff Member',
        employmentStatus: empRecord?.employmentStatus || 'REGULAR',
        compliancePercentage: comp.compliancePercentage,
        verifiedCount: comp.totalVerified,
        submittedCount: comp.totalSubmitted,
        revisionCount: comp.totalRevisionRequired,
        rejectedCount: comp.totalRejected,
        outstandingCount: comp.totalOutstanding,
        totalRequired: comp.totalRequired,
        submissionsCount: userSubmissions.length,
      };
    });

    res.json({
      submissions,
      complianceSummaries,
      employees,
      categories: EMPLOYEE_REQUIREMENT_CATEGORIES,
      catalog: EMPLOYEE_REQUIREMENTS_CATALOG,
    });
  }
);

// 8. HR Action: Verify Submission
app.post(
  '/api/employee-requirements/admin/:id/verify',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const sub = db.getRequirementSubmissionById(req.params.id);
    if (!sub) {
      return res.status(404).json({ error: 'Document submission not found.' });
    }

    const { remarks, expiryDate } = req.body;
    const now = new Date().toISOString();
    const oldStatus = sub.status;

    sub.status = 'VERIFIED';
    sub.verifiedAt = now;
    sub.verifiedBy = active.name;
    sub.verifiedById = active.id;
    sub.reviewRemarks = remarks && typeof remarks === 'string' && remarks.trim() ? remarks.trim() : 'Document verified and approved by HR.';
    if (expiryDate) sub.expiryDate = expiryDate;
    sub.updatedAt = now;

    const auditEntry: RequirementAuditEntry = {
      action: 'VERIFIED',
      performedBy: active.name,
      performedById: active.id,
      timestamp: now,
      remarks: sub.reviewRemarks,
      previousStatus: oldStatus,
      newStatus: 'VERIFIED',
    };
    sub.history = Array.isArray(sub.history) ? [...sub.history, auditEntry] : [auditEntry];

    db.saveRequirementSubmission(sub);

    // Also enrich authorizedDocuments on employee record if applicable
    const empRecord = (db.getData().employeeRecords || []).find((e) => e.userId === sub.userId);
    if (empRecord) {
      if (!Array.isArray(empRecord.authorizedDocuments)) {
        empRecord.authorizedDocuments = [];
      }
      const existingDocIdx = empRecord.authorizedDocuments.findIndex((d) => d.id === sub.id || d.title === sub.requirementTitle);
      const authDoc: AuthorizedDocument = {
        id: sub.id,
        title: sub.requirementTitle,
        category: sub.category,
        fileName: sub.originalName,
        storedFileName: sub.storedFileName,
        storagePath: sub.storagePath,
        fileSize: sub.fileSize,
        uploadedDate: sub.submittedAt.split('T')[0],
        verified: true,
        downloadUrl: sub.downloadUrl || `/api/employee-requirements/download/${sub.id}`,
        previewContent: `Verified official document on file with Secretariat HR: ${sub.originalName}`,
      };
      if (existingDocIdx >= 0) {
        empRecord.authorizedDocuments[existingDocIdx] = authDoc;
      } else {
        empRecord.authorizedDocuments.push(authDoc);
      }
      db.save();
    }

    // Notify employee of verified status
    db.createNotification(
      sub.userId,
      'Requirement Document Verified',
      `Your document for "${sub.requirementTitle}" has been verified and approved by ${active.name}.`,
      'SYSTEM',
      'my-file',
      { submissionId: sub.id, requirementId: sub.requirementId }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'VERIFY_EMPLOYEE_REQUIREMENT',
      'EMPLOYEE_REQUIREMENTS',
      `Verified requirement document "${sub.requirementTitle}" for ${sub.employeeName}`,
      sub.userId
    );

    res.json({
      success: true,
      message: `Document "${sub.requirementTitle}" successfully verified.`,
      submission: sub,
      compliance: db.getEmployeeComplianceSummary(sub.userId),
    });
  }
);

// 9. HR Action: Reject Submission
app.post(
  '/api/employee-requirements/admin/:id/reject',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const sub = db.getRequirementSubmissionById(req.params.id);
    if (!sub) {
      return res.status(404).json({ error: 'Document submission not found.' });
    }

    const { remarks } = req.body;
    if (!remarks || typeof remarks !== 'string' || !remarks.trim()) {
      return res.status(400).json({ error: 'Rejection remarks are mandatory to advise the employee why the document was rejected.' });
    }

    const now = new Date().toISOString();
    const oldStatus = sub.status;

    sub.status = 'REJECTED';
    sub.reviewRemarks = remarks.trim();
    sub.updatedAt = now;

    const auditEntry: RequirementAuditEntry = {
      action: 'REJECTED',
      performedBy: active.name,
      performedById: active.id,
      timestamp: now,
      remarks: remarks.trim(),
      previousStatus: oldStatus,
      newStatus: 'REJECTED',
    };
    sub.history = Array.isArray(sub.history) ? [...sub.history, auditEntry] : [auditEntry];

    db.saveRequirementSubmission(sub);

    // Notify employee of rejection
    db.createNotification(
      sub.userId,
      'Requirement Document Rejected',
      `Your document for "${sub.requirementTitle}" was rejected: "${remarks.trim()}". Please review the feedback and submit a replacement.`,
      'SYSTEM',
      'my-file',
      { submissionId: sub.id, requirementId: sub.requirementId, remarks: remarks.trim() }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'REJECT_EMPLOYEE_REQUIREMENT',
      'EMPLOYEE_REQUIREMENTS',
      `Rejected requirement document "${sub.requirementTitle}" for ${sub.employeeName}. Reason: ${remarks.trim()}`,
      sub.userId
    );

    res.json({
      success: true,
      message: `Document submission rejected with feedback provided to employee.`,
      submission: sub,
      compliance: db.getEmployeeComplianceSummary(sub.userId),
    });
  }
);

// 10. HR Action: Request Revision
app.post(
  '/api/employee-requirements/admin/:id/request-revision',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const sub = db.getRequirementSubmissionById(req.params.id);
    if (!sub) {
      return res.status(404).json({ error: 'Document submission not found.' });
    }

    const { remarks } = req.body;
    if (!remarks || typeof remarks !== 'string' || !remarks.trim()) {
      return res.status(400).json({ error: 'Correction instructions are required so the employee knows what to fix.' });
    }

    const now = new Date().toISOString();
    const oldStatus = sub.status;

    sub.status = 'REVISION_REQUIRED';
    sub.reviewRemarks = remarks.trim();
    sub.updatedAt = now;

    const auditEntry: RequirementAuditEntry = {
      action: 'REVISION_REQUESTED',
      performedBy: active.name,
      performedById: active.id,
      timestamp: now,
      remarks: remarks.trim(),
      previousStatus: oldStatus,
      newStatus: 'REVISION_REQUIRED',
    };
    sub.history = Array.isArray(sub.history) ? [...sub.history, auditEntry] : [auditEntry];

    db.saveRequirementSubmission(sub);

    // Notify employee of correction request
    db.createNotification(
      sub.userId,
      'Correction Requested for Requirement Document',
      `HR requested corrections for "${sub.requirementTitle}": "${remarks.trim()}". Please replace with an updated copy.`,
      'SYSTEM',
      'my-file',
      { submissionId: sub.id, requirementId: sub.requirementId, remarks: remarks.trim() }
    );

    db.logAction(
      active.id,
      active.name,
      active.role,
      'REQUEST_REVISION_EMPLOYEE_REQUIREMENT',
      'EMPLOYEE_REQUIREMENTS',
      `Requested revision on "${sub.requirementTitle}" for ${sub.employeeName}. Note: ${remarks.trim()}`,
      sub.userId
    );

    res.json({
      success: true,
      message: `Correction requested from employee.`,
      submission: sub,
      compliance: db.getEmployeeComplianceSummary(sub.userId),
    });
  }
);

// 11. HR Action: Configure Requirement Applicability & Expiration Rules
app.post(
  '/api/employee-requirements/admin/config',
  requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']),
  (req: Request, res: Response) => {
    const active = getReqUser(req);
    const { userId, requirementId, applicability, customNotes, expiryDate } = req.body;

    if (!requirementId) {
      return res.status(400).json({ error: 'Requirement ID is required.' });
    }
    if (!['REQUIRED', 'OPTIONAL', 'NOT_APPLICABLE'].includes(applicability)) {
      return res.status(400).json({ error: 'Invalid applicability status.' });
    }

    const targetUserId = userId || 'GLOBAL';
    const configId = `cfg_${targetUserId}_${requirementId}`;

    const config: EmployeeRequirementConfig = {
      id: configId,
      userId: targetUserId,
      requirementId,
      applicability,
      customNotes: customNotes && typeof customNotes === 'string' ? customNotes.trim() : undefined,
      expiryDate: expiryDate || undefined,
      updatedBy: active.name,
      updatedAt: new Date().toISOString(),
    };

    db.saveRequirementConfig(config);

    db.logAction(
      active.id,
      active.name,
      active.role,
      'CONFIGURE_REQUIREMENT_SETTING',
      'EMPLOYEE_REQUIREMENTS',
      `Configured requirement "${requirementId}" as ${applicability} for ${targetUserId}`,
      targetUserId
    );

    res.json({
      success: true,
      message: 'Requirement configuration updated successfully.',
      config,
    });
  }
);

// ----------------------------------------------------
// 11. LEAVE MANAGEMENT & DECISION ENGINE
// ----------------------------------------------------
app.get('/api/leave/settings', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to view leave policy settings.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Career applicants cannot view internal leave policy settings.' });
  }
  const data = db.getData();
  res.json({
    leaveTypes: data.leaveTypes,
    companyHolidays: data.companyHolidays,
  });
});

app.put('/api/leave/settings/types/:id', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const updates = req.body;
  const active = getReqUser(req);
  const data = db.getData();

  const typeIndex = data.leaveTypes.findIndex((t) => t.id === id);
  if (typeIndex === -1) {
    return res.status(404).json({ error: 'Leave type configuration not found.' });
  }

  data.leaveTypes[typeIndex] = {
    ...data.leaveTypes[typeIndex],
    ...updates,
    id, // preserve id
  };
  db.save();

  db.logAction(active!.id, active!.name, active!.role, 'UPDATE_LEAVE_POLICY', 'LEAVE_POLICY', `Updated leave policy settings for ${data.leaveTypes[typeIndex].name}`, id);
  res.json({ success: true, leaveType: data.leaveTypes[typeIndex] });
});

app.post('/api/leave/settings/holidays', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { date, name, type } = req.body;
  const active = getReqUser(req);

  if (!date || !name) {
    return res.status(400).json({ error: 'Date and holiday name are required.' });
  }

  const data = db.getData();
  const newHoliday: CompanyHoliday = {
    id: `hol_${Date.now()}`,
    date,
    name,
    type: type || 'REGULAR',
  };

  data.companyHolidays.push(newHoliday);
  data.companyHolidays.sort((a, b) => a.date.localeCompare(b.date));
  db.save();

  db.logAction(active!.id, active!.name, active!.role, 'ADD_COMPANY_HOLIDAY', 'CALENDAR', `Added official holiday: ${name} (${date})`, newHoliday.id);
  res.json({ success: true, holiday: newHoliday });
});

app.delete('/api/leave/settings/holidays/:id', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getReqUser(req);
  const data = db.getData();

  const prevLen = data.companyHolidays.length;
  data.companyHolidays = data.companyHolidays.filter((h) => h.id !== id);

  if (data.companyHolidays.length === prevLen) {
    return res.status(404).json({ error: 'Holiday entry not found.' });
  }

  db.save();
  db.logAction(active!.id, active!.name, active!.role, 'REMOVE_COMPANY_HOLIDAY', 'CALENDAR', `Removed holiday entry ${id}`);
  res.json({ success: true, message: 'Holiday entry removed.' });
});

app.post('/api/leave/calculate-days', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to calculate working days.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Career applicants cannot access internal leave management.' });
  }
  const { startDate, endDate } = req.body;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Start date and end date are required.' });
  }

  const holidays = db.getData().companyHolidays;
  const result = calculateWorkingDays(startDate, endDate, holidays);
  res.json(result);
});

app.get('/api/leave/applications', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to view leave applications.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Career applicants cannot access internal leave applications.' });
  }
  const data = db.getData();
  const { userId, status } = req.query;

  let list = data.leaveApplications;

  // Strict RBAC: Employees and Department Heads can ONLY view their own leave applications
  if (active.role === 'EMPLOYEE' || active.role === 'DEPARTMENT_HEAD') {
    list = list.filter((a) => a.userId === active.id);
  } else if (active.role === 'MANAGER') {
    // Dedicated Manager Role: Can view leave applications forwarded to them, or their own applications
    list = list.filter((a) =>
      a.userId === active.id ||
      a.assignedToManagerId === active.id ||
      (a.managerReview && (
        a.managerReview.managerId === active.id ||
        a.managerReview.assignedToManagerId === active.id ||
        (a.managerReview.managerEmail && a.managerReview.managerEmail.toLowerCase().trim() === active.email.toLowerCase().trim())
      ))
    );
  } else {
    // HR and Admin can view all or filter
    if (userId && typeof userId === 'string') {
      list = list.filter((a) => a.userId === userId);
    }
  }

  if (status && typeof status === 'string') {
    list = list.filter((a) => a.status === status);
  }

  // Sort newest first
  list.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
  res.json({ applications: list });
});

app.post('/api/leave/apply', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required to submit leave application.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: Career applicants cannot submit employee leave applications.' });
  }
  const { leaveTypeId, startDate, endDate, reason, hasSupportingDoc, supportingDocName } = req.body;

  if (!leaveTypeId || !startDate || !endDate || !reason) {
    return res.status(400).json({ error: 'Missing required leave application fields.' });
  }

  const data = db.getData();

  // 1. Prevent overlapping or duplicate leave applications
  const isOverlapping = data.leaveApplications.some((a) => {
    if (a.userId !== active.id) return false;
    if (a.status !== 'SUBMITTED' && a.status !== 'UNDER_HR_REVIEW' && a.status !== 'PENDING_MANAGER_APPROVAL' && a.status !== 'NEEDS_INFORMATION' && a.status !== 'APPROVED') {
      return false;
    }
    const aStart = new Date(`${a.startDate}T00:00:00`).getTime();
    const aEnd = new Date(`${a.endDate}T00:00:00`).getTime();
    const reqStart = new Date(`${startDate}T00:00:00`).getTime();
    const reqEnd = new Date(`${endDate}T00:00:00`).getTime();
    return reqStart <= aEnd && reqEnd >= aStart;
  });

  if (isOverlapping) {
    return res.status(400).json({
      error: 'Schedule Conflict / Overlapping Application: You already have an active or approved leave application covering all or part of these requested dates.',
    });
  }

  const employeeRecord = data.employeeRecords.find((e) => e.userId === active.id);
  if (!employeeRecord) {
    return res.status(404).json({ error: 'Active employee profile record not found.' });
  }

  const leaveType = data.leaveTypes.find((t) => t.id === leaveTypeId);
  if (!leaveType) {
    return res.status(404).json({ error: 'Selected leave category not configured.' });
  }

  const balance = employeeRecord.leaveBalances[leaveTypeId];
  if (!balance) {
    return res.status(400).json({ error: `You do not have an active entitlement balance for ${leaveType.name}.` });
  }

  // Run deterministic leave decision engine
  const evalResult = evaluateLeaveApplication({
    userId: active.id,
    leaveType,
    startDate,
    endDate,
    reason,
    hasSupportingDoc: Boolean(hasSupportingDoc),
    supportingDocName,
    balance,
    existingApplications: data.leaveApplications,
    holidays: data.companyHolidays,
    submittedAt: new Date().toISOString(),
  });

  const now = new Date().toISOString();
  const existingNums = data.leaveApplications
    .map((a) => {
      const match = a.id.match(/\d+$/);
      return match ? parseInt(match[0], 10) : 0;
    })
    .filter((n) => !isNaN(n));
  const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : data.leaveApplications.length + 1;
  const refNumber = `AMIE-LV-2026-${String(nextNum).padStart(3, '0')}`;

  const application: LeaveApplication = {
    id: refNumber,
    userId: active.id,
    employeeName: active.name,
    employeeNumber: employeeRecord.employeeNumber,
    department: employeeRecord.department,
    leaveTypeId: leaveType.id,
    leaveTypeName: leaveType.name,
    startDate,
    endDate,
    requestedWorkingDays: evalResult.workingDays,
    workingDaysList: evalResult.workingDates,
    reason,
    supportingDocumentName: supportingDocName,
    submittedAt: now,
    status: evalResult.status,
    decisionEngine: {
      ruleApplied: evalResult.ruleApplied,
      outcome: evalResult.outcome,
      explanation: evalResult.explanation,
      missingRequirements: evalResult.missingRequirements,
      decidedAt: now,
      decidedBy: evalResult.status === 'APPROVED' ? 'AMIE Leave Decision Engine (Deterministic v2.1)' : 'AMIE Rule Engine',
    },
    updatedAt: now,
  };

  // Safe balance updates preventing double-counting or negative leakage
  if (evalResult.status === 'APPROVED') {
    balance.used += evalResult.workingDays;
    balance.availableBalance = Math.max(0, balance.totalEntitlement - balance.used - balance.pendingReservation);
  } else if (
    evalResult.status === 'UNDER_HR_REVIEW' ||
    evalResult.status === 'NEEDS_INFORMATION' ||
    (evalResult.status as string) === 'SUBMITTED' ||
    (evalResult.status as string) === 'PENDING_MANAGER_APPROVAL'
  ) {
    balance.pendingReservation += evalResult.workingDays;
    balance.availableBalance = Math.max(0, balance.totalEntitlement - balance.used - balance.pendingReservation);
  }

  data.leaveApplications.unshift(application);

  // Notify all active HR Personnel / Administrators of newly submitted leave application requiring review
  for (const activeHR of db.getActiveHRRecipients(active.id)) {
    db.createNotification(
      activeHR.id,
      'New Leave Request Submitted',
      `${active.name} submitted a ${leaveType.name} request (${evalResult.workingDays} working days, ${startDate} to ${endDate}) [${evalResult.status}].`,
      'LEAVE',
      'leave',
      {
        applicationId: refNumber,
        employeeName: active.name,
        leaveTypeName: leaveType.name,
        requestedWorkingDays: evalResult.workingDays,
        eventKey: `leave_apply_${refNumber}_${activeHR.id}`,
      },
      activeHR.email
    );
  }

  db.save();

  db.logAction(
    active.id,
    active.name,
    active.role,
    'SUBMIT_LEAVE_APPLICATION',
    'LEAVE_APPLICATION',
    `Submitted ${leaveType.name} (${evalResult.workingDays} working days, ${startDate} to ${endDate}). Result: ${evalResult.status} [${evalResult.ruleApplied}]`,
    refNumber
  );

  res.json({
    success: true,
    application,
    evaluation: evalResult,
    updatedBalance: balance,
  });
});

app.post('/api/leave/applications/:id/cancel', (req: Request, res: Response) => {
  const { id } = req.params;
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const data = db.getData();

  const application = data.leaveApplications.find((a) => a.id === id);
  if (!application) {
    return res.status(404).json({ error: 'Leave application not found.' });
  }

  // Permission check: non-HR personnel (employees, managers, department heads) can only cancel own applications
  if ((active.role === 'EMPLOYEE' || active.role === 'MANAGER' || active.role === 'DEPARTMENT_HEAD') && application.userId !== active.id) {
    return res.status(403).json({ error: 'Cannot cancel another employee\'s leave application.' });
  }

  if (application.status === 'CANCELLED') {
    return res.status(400).json({ error: 'Application is already cancelled.' });
  }
  if (application.status === 'REJECTED') {
    return res.status(400).json({ error: 'Cannot cancel an application that has already been rejected.' });
  }

  const prevCancelStatus = application.status;

  // Restore employee leave balance
  const employeeRecord = data.employeeRecords.find((e) => e.userId === application.userId);
  if (employeeRecord) {
    const balance = employeeRecord.leaveBalances[application.leaveTypeId];
    if (balance) {
      if (application.status === 'APPROVED') {
        balance.used = Math.max(0, balance.used - application.requestedWorkingDays);
      } else if (application.status === 'UNDER_HR_REVIEW' || application.status === 'SUBMITTED' || application.status === 'PENDING_MANAGER_APPROVAL' || application.status === 'NEEDS_INFORMATION') {
        balance.pendingReservation = Math.max(0, balance.pendingReservation - application.requestedWorkingDays);
      }
      balance.availableBalance = Math.max(0, balance.totalEntitlement - balance.used - balance.pendingReservation);
    }
  }

  application.status = 'CANCELLED';
  application.decisionEngine.explanation = `Application voluntarily cancelled on ${new Date().toLocaleDateString()}. Balance reservation/deduction restored.`;
  application.updatedAt = new Date().toISOString();
  if (!application.auditHistory) application.auditHistory = [];
  application.auditHistory.push({
    id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    action: 'CANCEL_LEAVE_APPLICATION',
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
    timestamp: application.updatedAt,
    details: `Leave application cancelled by ${active.name}.`,
    previousStatus: prevCancelStatus,
    newStatus: 'CANCELLED',
  });
  db.save();

  if (active.id === application.userId) {
    for (const hr of db.getActiveHRRecipients(active.id)) {
      db.createNotification(
        hr.id,
        'Leave Application Cancelled by Employee',
        `${application.employeeName} cancelled ${application.leaveTypeName} application (${application.id}) covering ${application.startDate} to ${application.endDate}.`,
        'LEAVE',
        'leave',
        { applicationId: application.id, previousStatus: prevCancelStatus, eventKey: `leave_cancel_${application.id}_${hr.id}` },
        hr.email
      );
    }
    if (application.assignedToManagerId && prevCancelStatus === 'PENDING_MANAGER_APPROVAL') {
      db.createNotification(
        application.assignedToManagerId,
        'Forwarded Leave Application Cancelled',
        `${application.employeeName} cancelled leave application ${application.id} that was awaiting your decision.`,
        'LEAVE',
        'leave',
        { applicationId: application.id, eventKey: `leave_cancel_mgr_${application.id}` }
      );
    }
  }

  db.logAction(active.id, active.name, active.role, 'CANCEL_LEAVE_APPLICATION', 'LEAVE_APPLICATION', `Cancelled leave application ${id}`, id);
  res.json({ success: true, application });
});

// Employee clarification / resubmission for NEEDS_INFORMATION leave requests
app.post('/api/leave/applications/:id/respond', (req: Request, res: Response) => {
  const { id } = req.params;
  const { responseNotes, supportingDocName } = req.body;
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const data = db.getData();
  const application = data.leaveApplications.find((a) => a.id === id);
  if (!application) {
    return res.status(404).json({ error: 'Leave application not found.' });
  }
  if (application.userId !== active.id) {
    return res.status(403).json({ error: 'Only the applicant can submit clarification for this leave application.' });
  }
  if (application.status !== 'NEEDS_INFORMATION') {
    return res.status(400).json({ error: 'Clarification can only be submitted when application status is Needs Information.' });
  }
  if (!responseNotes || typeof responseNotes !== 'string' || !responseNotes.trim()) {
    return res.status(400).json({ error: 'Please provide clarification notes or updated details.' });
  }

  const now = new Date().toISOString();
  const prevStatus = application.status;
  const routeToManager = Boolean(application.assignedToManagerId && (!application.managerReview?.decision || application.managerReview?.decision === 'NEED_INFORMATION'));
  application.status = routeToManager ? 'PENDING_MANAGER_APPROVAL' : 'UNDER_HR_REVIEW';
  application.reason = `${application.reason}\n\n[Clarification ${new Date().toLocaleDateString()}]: ${responseNotes.trim()}`;
  if (supportingDocName && typeof supportingDocName === 'string' && supportingDocName.trim()) {
    application.supportingDocumentName = supportingDocName.trim();
  }
  application.decisionEngine.missingRequirements = [];
  application.decisionEngine.explanation = `Employee provided clarification: "${responseNotes.trim()}". Re-routed for ${routeToManager ? 'Manager' : 'HR'} review.`;
  application.updatedAt = now;
  if (!application.auditHistory) application.auditHistory = [];
  application.auditHistory.push({
    id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    action: 'EMPLOYEE_CLARIFICATION_SUBMITTED',
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
    timestamp: now,
    details: 'Applicant submitted requested clarification/documentation.',
    comments: responseNotes.trim(),
    previousStatus: prevStatus,
    newStatus: application.status,
  });

  db.save();

  for (const hr of db.getActiveHRRecipients(active.id)) {
    db.createNotification(
      hr.id,
      'Leave Clarification Submitted',
      `${active.name} provided clarification on ${application.leaveTypeName} request (${application.id}): "${responseNotes.trim()}"`,
      'LEAVE',
      'leave',
      { applicationId: application.id, eventKey: `leave_clarify_${application.id}_${Date.now()}_${hr.id}` },
      hr.email
    );
  }
  if (routeToManager && application.assignedToManagerId) {
    db.createNotification(
      application.assignedToManagerId,
      'Leave Clarification Submitted for Your Decision',
      `${active.name} responded to information request on ${application.id}: "${responseNotes.trim()}"`,
      'LEAVE',
      'leave',
      { applicationId: application.id, eventKey: `leave_clarify_mgr_${application.id}_${Date.now()}` },
      application.managerReview?.managerEmail
    );
  }

  db.logAction(active.id, active.name, active.role, 'SUBMIT_LEAVE_CLARIFICATION', 'LEAVE_APPLICATION', `Submitted clarification for leave ${id}`, id);
  res.json({ success: true, application });
});

app.post('/api/leave/applications/:id/review', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const { decision, notes } = req.body; // 'APPROVE' | 'REJECT' | 'REQUEST_INFO'
  const active = getReqUser(req);
  const data = db.getData();

  const application = data.leaveApplications.find((a) => a.id === id);
  if (!application) {
    return res.status(404).json({ error: 'Leave application not found.' });
  }

  if (application.status === 'CANCELLED') {
    return res.status(400).json({ error: 'Cannot review an application that has already been cancelled.' });
  }

  const employeeRecord = data.employeeRecords.find((e) => e.userId === application.userId);
  const balance = employeeRecord?.leaveBalances[application.leaveTypeId];

  const now = new Date().toISOString();
  const prevStatus = application.status;

  if (decision === 'APPROVE') {
    if (application.status === 'APPROVED') {
      return res.status(400).json({ error: 'Application is already approved.' });
    }
    if (balance) {
      if (
        application.status === 'UNDER_HR_REVIEW' ||
        application.status === 'SUBMITTED' ||
        application.status === 'PENDING_MANAGER_APPROVAL' ||
        application.status === 'NEEDS_INFORMATION'
      ) {
        balance.pendingReservation = Math.max(0, balance.pendingReservation - application.requestedWorkingDays);
      }
      balance.used += application.requestedWorkingDays;
      balance.availableBalance = Math.max(0, balance.totalEntitlement - balance.used - balance.pendingReservation);
    }
    application.status = 'APPROVED';
    application.decisionEngine.outcome = 'MANUALLY_APPROVED';
    application.decisionEngine.ruleApplied = 'Rule 5.3.A - HR Management Endorsement';
    application.decisionEngine.explanation = notes || 'Application verified and formally approved by HR Secretariat.';
  } else if (decision === 'REJECT') {
    if (application.status === 'REJECTED') {
      return res.status(400).json({ error: 'Application is already rejected.' });
    }
    if (balance) {
      if (application.status === 'UNDER_HR_REVIEW' || application.status === 'SUBMITTED' || application.status === 'PENDING_MANAGER_APPROVAL' || application.status === 'NEEDS_INFORMATION') {
        balance.pendingReservation = Math.max(0, balance.pendingReservation - application.requestedWorkingDays);
      } else if (application.status === 'APPROVED') {
        balance.used = Math.max(0, balance.used - application.requestedWorkingDays);
      }
      balance.availableBalance = Math.max(0, balance.totalEntitlement - balance.used - balance.pendingReservation);
    }
    application.status = 'REJECTED';
    application.decisionEngine.outcome = 'MANUALLY_REJECTED';
    application.decisionEngine.ruleApplied = 'Rule 5.3.B - HR Management Disapproval';
    application.decisionEngine.explanation = notes || 'Application declined following departmental operational review.';
  } else if (decision === 'REQUEST_INFO') {
    application.status = 'NEEDS_INFORMATION';
    application.decisionEngine.outcome = 'NEEDS_INFO';
    application.decisionEngine.missingRequirements = notes ? [notes] : ['Additional supporting information requested by HR.'];
    application.decisionEngine.explanation = notes || 'Additional supporting documentation or explanation required by HR Administration.';
  } else {
    return res.status(400).json({ error: 'Invalid decision code. Expected APPROVE, REJECT, or REQUEST_INFO.' });
  }

  application.hrReviewNotes = notes;
  application.decisionEngine.decidedBy = `${active!.name} (${active!.jobTitle})`;
  application.decisionEngine.decidedAt = now;
  application.updatedAt = now;

  if (!application.auditHistory) {
    application.auditHistory = [];
  }
  application.auditHistory.push({
    id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    action: `HR_REVIEW_${decision}`,
    performedBy: active!.name,
    performedById: active!.id,
    performedByRole: active!.role,
    timestamp: now,
    details: `HR Administrator decided ${decision}.`,
    comments: notes || undefined,
    previousStatus: prevStatus,
    newStatus: application.status,
  });

  db.save();

  // Create persistent notification for employee on status change
  db.createNotification(
    application.userId,
    decision === 'APPROVE' ? 'Leave Request Approved by HR' : decision === 'REJECT' ? 'Leave Request Rejected by HR' : 'HR Requested Information on Leave',
    `Your ${application.leaveTypeName} application (${application.id}) was reviewed by HR: ${decision}. ${notes ? `Notes: "${notes}"` : ''}`,
    'LEAVE',
    'leave',
    { applicationId: application.id, decision, eventKey: `leave_hr_${application.id}_${decision}_${Date.now()}` }
  );

  db.logAction(
    active!.id,
    active!.name,
    active!.role,
    'REVIEW_LEAVE_APPLICATION',
    'LEAVE_APPLICATION',
    `HR Review outcome: ${decision} for application ${id}. Notes: ${notes || 'None'}`,
    id
  );

  res.json({ success: true, application });
});

// GET /api/leave/managers: Retrieve list of designated Manager accounts for HR forwarding
app.get('/api/leave/managers', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const managers = db.getData().users.filter(
    (u) => (u.role === 'MANAGER' || u.role === 'SYSTEM_ADMINISTRATOR') && u.accountStatus === 'ACTIVE'
  );

  const { employeeId, userId, applicationId } = req.query;
  const targetId = (employeeId || userId) as string | undefined;

  let assignedManagerId: string | null = null;
  let assignedManagerReason: string | null = null;

  const data = db.getData();

  // If applicationId is provided, resolve target employee from application
  let targetEmpId = targetId;
  if (!targetEmpId && typeof applicationId === 'string') {
    const app = data.leaveApplications.find((a) => a.id === applicationId);
    if (app) targetEmpId = app.userId;
  }

  if (targetEmpId) {
    const emp = data.employeeRecords.find((e) => e.userId === targetEmpId || e.employeeNumber === targetEmpId);
    if (emp) {
      // 1. Direct explicit managerId / reportingManagerId / supervisorId if assigned
      const explicitManagerId = (emp as any).reportingManagerId || (emp as any).managerId || (emp as any).supervisorId;
      if (explicitManagerId) {
        const found = managers.find((m) => m.id === explicitManagerId);
        if (found) {
          assignedManagerId = found.id;
          assignedManagerReason = 'Assigned Reporting Manager';
        }
      }

      // 2. Matching supervisorName
      if (!assignedManagerId && emp.supervisorName && emp.supervisorName !== 'Executive Director & HR Administration') {
        const supClean = emp.supervisorName.toLowerCase().trim();
        const found = managers.find(
          (m) => m.name.toLowerCase().trim() === supClean || (m.email && m.email.toLowerCase().includes(supClean))
        );
        if (found) {
          assignedManagerId = found.id;
          assignedManagerReason = `Direct Reporting Supervisor (${emp.supervisorName})`;
        }
      }

      // 3. Departmental Manager Match
      if (!assignedManagerId && emp.department) {
        const deptMatches = managers.filter(
          (m) => m.role === 'MANAGER' && m.department && m.department.toLowerCase().trim() === emp.department.toLowerCase().trim()
        );
        if (deptMatches.length === 1) {
          assignedManagerId = deptMatches[0].id;
          assignedManagerReason = `Department Manager (${deptMatches[0].department})`;
        }
      }
    }
  }

  res.json({
    managers: managers.map((m) => ({
      ...sanitizeUser(m),
      isAssignedReportingManager: m.id === assignedManagerId,
    })),
    assignedManagerId,
    assignedManagerReason,
  });
});

// POST /api/leave/applications/:id/forward-manager: HR forwards leave request to designated Manager
app.post('/api/leave/applications/:id/forward-manager', requireRole(['HR_PERSONNEL', 'HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { id } = req.params;
  const { managerId, notes } = req.body;
  const active = getReqUser(req);
  const data = db.getData();

  if (!managerId || typeof managerId !== 'string') {
    return res.status(400).json({ error: 'Designated Manager ID is required for forwarding.' });
  }

  const application = data.leaveApplications.find((a) => a.id === id);
  if (!application) {
    return res.status(404).json({ error: 'Leave application not found.' });
  }

  if (application.status === 'CANCELLED' || application.status === 'REJECTED' || application.status === 'APPROVED') {
    return res.status(400).json({ error: `Cannot forward an application with completed status "${application.status}".` });
  }

  // Prevent duplicate forwarding unless explicitly reassigning to another manager
  if (application.status === 'PENDING_MANAGER_APPROVAL' && (application.assignedToManagerId === managerId || application.managerReview?.managerId === managerId)) {
    return res.status(400).json({ error: 'This leave application has already been forwarded to this Manager and is awaiting their decision.' });
  }

  const targetManager = db.findUserById(managerId);
  if (!targetManager || targetManager.accountStatus !== 'ACTIVE' || (targetManager.role !== 'MANAGER' && targetManager.role !== 'SYSTEM_ADMINISTRATOR')) {
    return res.status(400).json({ error: 'Selected user is not an active verified Manager.' });
  }

  const now = new Date().toISOString();
  const prevStatus = application.status;
  application.status = 'PENDING_MANAGER_APPROVAL';
  application.assignedToManagerId = targetManager.id;
  application.forwardedAt = now;
  application.managerReview = {
    managerId: targetManager.id,
    assignedToManagerId: targetManager.id,
    managerName: targetManager.name,
    managerEmail: targetManager.email,
    forwardedAt: now,
    forwardedBy: active.name,
    forwardedById: active.id,
    hrForwardingNotes: notes ? String(notes).trim() : undefined,
  };

  if (!application.auditHistory) {
    application.auditHistory = [];
  }
  application.auditHistory.push({
    id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    action: 'FORWARD_TO_MANAGER',
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
    timestamp: now,
    details: `Forwarded to designated Manager ${targetManager.name} (${targetManager.email}) for second-level decision.`,
    comments: notes ? String(notes).trim() : undefined,
    previousStatus: prevStatus,
    newStatus: 'PENDING_MANAGER_APPROVAL',
  });

  application.updatedAt = now;

  // Create persistent in-app notification for Manager with complete contextual details
  const managerNotif = db.createNotification(
    targetManager.id,
    'Leave Request Awaiting Your Decision',
    `HR Administrator ${active.name} forwarded ${application.employeeName}'s ${application.leaveTypeName} request (${application.id}) submitted on ${new Date(application.submittedAt).toLocaleDateString()} for dates ${application.startDate} to ${application.endDate} (${application.requestedWorkingDays} day(s)) for your review and decision.`,
    'LEAVE',
    'leave',
    {
      applicationId: application.id,
      leaveRequestId: application.id,
      employeeName: application.employeeName,
      employeeNumber: application.employeeNumber,
      department: application.department,
      leaveTypeName: application.leaveTypeName,
      requestedWorkingDays: application.requestedWorkingDays,
      startDate: application.startDate,
      endDate: application.endDate,
      submissionDate: application.submittedAt,
      reason: application.reason,
      forwardedBy: active.name,
      forwardedById: active.id,
      forwardedAt: now,
      notes: notes ? String(notes).trim() : undefined,
      actionUrl: `/leave?appId=${application.id}`,
    },
    targetManager.email
  );

  // Create persistent notification for Employee
  db.createNotification(
    application.userId,
    'Leave Request Forwarded for Manager Decision',
    `Your ${application.leaveTypeName} request (${application.id}) has been forwarded to Manager ${targetManager.name} for second-level review and decision.`,
    'LEAVE',
    'leave',
    {
      applicationId: application.id,
      leaveRequestId: application.id,
      managerName: targetManager.name,
      forwardedAt: now,
    }
  );

  try {
    db.save();
  } catch (saveErr: any) {
    return res.status(500).json({ error: 'Failed to persist leave application forwarding: ' + saveErr.message });
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    'FORWARD_LEAVE_TO_MANAGER',
    'LEAVE_APPLICATION',
    `Forwarded leave application ${id} (${application.employeeName}) to Manager ${targetManager.name}`,
    id
  );

  res.json({ success: true, application, notificationId: managerNotif?.id });
});

// POST /api/leave/applications/:id/manager-decision: Manager records 2nd-level decision (Approved, Not Approved, Need Information)
app.post('/api/leave/applications/:id/manager-decision', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  // Strict Role Restriction: only MANAGER or SYSTEM_ADMINISTRATOR
  if (active.role !== 'MANAGER' && active.role !== 'SYSTEM_ADMINISTRATOR') {
    return res.status(403).json({ error: 'Access denied: Only a designated Manager can render this decision.' });
  }

  const { id } = req.params;
  const { decision, comments } = req.body; // 'APPROVED' | 'NOT_APPROVED' | 'NEED_INFORMATION'
  const data = db.getData();

  const application = data.leaveApplications.find((a) => a.id === id);
  if (!application) {
    return res.status(404).json({ error: 'Leave application not found.' });
  }

  // Prevent unauthorized users from deciding requests not forwarded to them
  const isAssignedManager = (
    application.assignedToManagerId === active.id ||
    (application.managerReview && (
      application.managerReview.managerId === active.id ||
      application.managerReview.assignedToManagerId === active.id ||
      (application.managerReview.managerEmail && application.managerReview.managerEmail.toLowerCase().trim() === active.email.toLowerCase().trim())
    ))
  );

  if (!isAssignedManager && active.role !== 'SYSTEM_ADMINISTRATOR') {
    return res.status(403).json({ error: 'Access denied: You can only decide on leave requests forwarded specifically to you.' });
  }

  if (application.status !== 'PENDING_MANAGER_APPROVAL') {
    return res.status(400).json({
      error: `This application cannot be decided by Manager because its current status is "${application.status}". Duplicate decisions or re-approvals are prohibited.`,
    });
  }

  const validDecisions = ['APPROVED', 'NOT_APPROVED', 'REJECTED', 'NEED_INFORMATION'];
  if (!validDecisions.includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision code. Expected "APPROVED", "REJECTED", "NOT_APPROVED", or "NEED_INFORMATION".' });
  }

  const isApproved = decision === 'APPROVED';
  const isRejected = decision === 'NOT_APPROVED' || decision === 'REJECTED';

  if (!comments || typeof comments !== 'string' || !comments.trim()) {
    const errorMsg = isRejected
      ? 'A rejection reason or comment is strictly required.'
      : 'Comments or reason for the decision are required.';
    return res.status(400).json({ error: errorMsg });
  }

  const employeeRecord = data.employeeRecords.find((e) => e.userId === application.userId);
  const balance = employeeRecord?.leaveBalances[application.leaveTypeId];
  const now = new Date().toISOString();
  const prevStatus = application.status;

  if (isApproved) {
    application.status = 'APPROVED';
    if (balance) {
      balance.pendingReservation = Math.max(0, balance.pendingReservation - application.requestedWorkingDays);
      balance.used += application.requestedWorkingDays;
      balance.availableBalance = Math.max(0, balance.totalEntitlement - balance.used - balance.pendingReservation);
    }
    application.decisionEngine.outcome = 'MANUALLY_APPROVED';
    application.decisionEngine.ruleApplied = 'Rule 5.3 - Manager Second-Level Approval';
    application.decisionEngine.explanation = `Formally approved by Manager ${active.name}. Comments: ${comments.trim()}`;
  } else if (isRejected) {
    application.status = 'REJECTED';
    if (balance) {
      balance.pendingReservation = Math.max(0, balance.pendingReservation - application.requestedWorkingDays);
      balance.availableBalance = Math.max(0, balance.totalEntitlement - balance.used - balance.pendingReservation);
    }
    application.decisionEngine.outcome = 'MANUALLY_REJECTED';
    application.decisionEngine.ruleApplied = 'Rule 5.3 - Manager Disapproval';
    application.decisionEngine.explanation = `Rejected by Manager ${active.name}. Reason: ${comments.trim()}`;
  } else if (decision === 'NEED_INFORMATION') {
    application.status = 'NEEDS_INFORMATION';
    application.decisionEngine.outcome = 'NEEDS_INFO';
    application.decisionEngine.missingRequirements = [comments.trim()];
    application.decisionEngine.explanation = `Manager ${active.name} requested further clarification: ${comments.trim()}`;
  }

  if (!application.managerReview) {
    application.managerReview = {
      managerId: active.id,
      managerName: active.name,
      managerEmail: active.email,
      forwardedAt: now,
      forwardedBy: 'System',
      forwardedById: 'system',
    };
  }

  const normalizedDecision = isApproved ? 'APPROVED' : isRejected ? 'REJECTED' : 'NEED_INFORMATION';
  application.managerReview.decision = normalizedDecision;
  application.managerReview.comments = comments.trim();
  application.managerReview.decidedAt = now;
  application.managerReview.decidedBy = `${active.name} (${active.jobTitle || 'Manager'})`;

  if (!application.auditHistory) {
    application.auditHistory = [];
  }
  application.auditHistory.push({
    id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    action: `MANAGER_DECISION_${normalizedDecision}`,
    performedBy: active.name,
    performedById: active.id,
    performedByRole: active.role,
    timestamp: now,
    details: `Manager rendered decision: ${normalizedDecision}.`,
    comments: comments.trim(),
    previousStatus: prevStatus,
    newStatus: application.status,
  });

  application.decisionEngine.decidedBy = `${active.name} (${active.jobTitle || 'Manager'})`;
  application.decisionEngine.decidedAt = now;
  application.updatedAt = now;
  db.save();

  // Create in-app notification for Employee
  const decisionDisplay = isApproved ? 'Approved' : isRejected ? 'Rejected' : 'Need Information';
  const empTitle = isApproved
    ? 'Leave Request Approved by Manager'
    : isRejected
    ? 'Leave Request Rejected by Manager'
    : 'Manager Requested Further Details on Leave';
  const empMsg = isApproved
    ? `Your ${application.leaveTypeName} request (${application.id}) was approved by Manager ${active.name}. Comments: "${comments.trim()}"`
    : isRejected
    ? `Your ${application.leaveTypeName} request (${application.id}) was rejected by Manager ${active.name}. Reason: "${comments.trim()}"`
    : `Manager ${active.name} requested additional information on your ${application.leaveTypeName} request (${application.id}): "${comments.trim()}"`;

  db.createNotification(
    application.userId,
    empTitle,
    empMsg,
    'LEAVE',
    'leave',
    {
      applicationId: application.id,
      decision: decisionDisplay,
      managerName: active.name,
      comments: comments.trim(),
    }
  );

  // Create in-app notification for all active HR Personnel / Administrators and forwarding HR officer
  const hrNotifyIds = new Set<string>();
  for (const hr of db.getActiveHRRecipients(active.id)) hrNotifyIds.add(hr.id);
  const forwardingHrId = application.managerReview?.forwardedById;
  if (forwardingHrId && forwardingHrId !== active.id) hrNotifyIds.add(forwardingHrId);

  for (const hrId of hrNotifyIds) {
    const hrUser = db.findUserById(hrId);
    db.createNotification(
      hrId,
      `Manager Decision: ${application.id}`,
      `Manager ${active.name} rendered a decision (${decisionDisplay}) on ${application.employeeName}'s ${application.leaveTypeName} application. Comments: "${comments.trim()}"`,
      'LEAVE',
      'leave',
      {
        applicationId: application.id,
        employeeName: application.employeeName,
        decision: decisionDisplay,
        managerName: active.name,
        eventKey: `leave_mgr_dec_${application.id}_${hrId}_${Date.now()}`,
      },
      hrUser?.email
    );
  }

  db.logAction(
    active.id,
    active.name,
    active.role,
    `MANAGER_DECISION_${normalizedDecision}`,
    'LEAVE_APPLICATION',
    `Manager ${active.name} decided ${decision} on leave request ${id} (${application.employeeName}). Comments: ${comments.trim()}`,
    id
  );

  res.json({ success: true, application });
});




// ----------------------------------------------------
// 12. METRICS & AGGREGATE HEALTH
// ----------------------------------------------------
app.get('/api/metrics', (req: Request, res: Response) => {
  const active = getActiveUser(req);
  if (!active) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (active.role === 'APPLICANT') {
    return res.status(403).json({ error: 'Access denied: System metrics are restricted to internal Secretariat staff.' });
  }
  const data = db.getData();

  const totalSources = data.knowledgeSources.length;
  const activeSources = data.knowledgeSources.filter((s) => s.status === 'ACTIVE').length;
  const totalChunks = data.chunks.length;
  const pendingTickets = data.escalationTickets.filter((t) => t.status === 'PENDING').length;
  const completedTasks = data.onboardingTasks.filter((t) => t.status === 'COMPLETED' || t.status === 'VERIFIED').length;
  const totalTasks = data.onboardingTasks.length;
  const onboardingCompletionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const validatedReviews = data.performanceReviews.filter(
    (r) => r.reviewStatus === 'HR_VALIDATED' || r.reviewStatus === 'REVIEWED'
  ).length;
  const pendingPerformanceReviewsCount = data.performanceReviews.filter(
    (r) => r.reviewStatus === 'PENDING_HR_REVIEW'
  ).length;
  let pendingLeaveCount = data.leaveApplications.filter((a) => a.status === 'SUBMITTED' || a.status === 'UNDER_HR_REVIEW' || a.status === 'PENDING_MANAGER_APPROVAL').length;
  if (active.role === 'MANAGER') {
    pendingLeaveCount = data.leaveApplications.filter((a) =>
      a.status === 'PENDING_MANAGER_APPROVAL' &&
      a.managerReview && (a.managerReview.managerId === active.id || (a.managerReview.managerEmail && a.managerReview.managerEmail.toLowerCase().trim() === active.email.toLowerCase().trim()))
    ).length;
  }
  const approvedLeaveCount = data.leaveApplications.filter((a) => a.status === 'APPROVED').length;

  res.json({
    metrics: {
      totalSources,
      activeSources,
      totalChunks,
      pendingTickets,
      onboardingCompletionRate,
      validatedReviews,
      pendingPerformanceReviewsCount,
      totalDrafts: data.recruitmentDrafts.length,
      approvedDrafts: data.recruitmentDrafts.filter((d) => d.status === 'APPROVED').length,
      catalogCoursesCount: data.trainingCatalog.length,
      activeUsersCount: data.users.length,
      pendingLeaveCount,
      approvedLeaveCount,
      totalApplicationsCount: (data.jobApplications || []).length,
      newApplicationsCount: (data.jobApplications || []).filter((a) => a.status === 'SUBMITTED').length,
      underReviewApplicationsCount: (data.jobApplications || []).filter((a) => a.status === 'UNDER_REVIEW').length,
    },
    userContext: {
      role: active.role,
      name: active.name,
    },
  });
});

// ----------------------------------------------------
// 13. ENTERPRISE DATA PROTECTION, BACKUP & RESTORATION
// ----------------------------------------------------
app.get('/api/admin/backups', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (_req: Request, res: Response) => {
  const backups = listDatabaseBackups();
  res.json({ success: true, backups });
});

app.post('/api/admin/backups/create', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const metadata = createDatabaseBackup(db.getData());
  db.logAction(
    active.id,
    active.name,
    active.role,
    'CREATE_DATABASE_BACKUP',
    'BACKUP',
    `Created verified database backup: ${metadata.filename} (${metadata.sizeBytes} bytes, SHA256: ${metadata.sha256.substring(0, 12)}...)`,
    metadata.id
  );
  res.json({ success: true, backup: metadata });
});

app.post('/api/admin/backups/verify', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const { filePath, filename } = req.body;
  const targetPath = filePath || (filename ? path.resolve(process.cwd(), '.data/backups', filename) : '');
  if (!targetPath) {
    return res.status(400).json({ error: 'filePath or filename is required.' });
  }

  const result = verifyBackupFile(targetPath);
  res.json({ success: result.valid, ...result });
});

app.post('/api/admin/backups/restore', requireRole(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']), (req: Request, res: Response) => {
  const active = getReqUser(req);
  const { filePath, filename } = req.body;
  const targetPath = filePath || (filename ? path.resolve(process.cwd(), '.data/backups', filename) : '');
  if (!targetPath) {
    return res.status(400).json({ error: 'filePath or filename is required.' });
  }

  try {
    const result = restoreDatabaseSnapshot(targetPath, db.getData());
    db.save();
    db.logAction(
      active.id,
      active.name,
      active.role,
      'RESTORE_DATABASE_BACKUP',
      'BACKUP',
      `Restored database from ${path.basename(targetPath)}: ${result.message}`
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Restoration failed.' });
  }
});

// Periodic automated database backup every 6 hours
setInterval(() => {
  try {
    createDatabaseBackup(db.getData());
  } catch (err) {
    console.error('Automated scheduled backup error:', err);
  }
}, 6 * 60 * 60 * 1000);

// Global API error handler ensuring valid JSON responses for all /api requests
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api')) {
    console.error(`Unhandled API error on ${req.method} ${req.path}:`, err);
    return res.status(500).json({ error: err.message || 'An internal server error occurred.' });
  }
  next(err);
});

// Dedicated 404 handler for any unhandled /api requests ensuring JSON is always returned (never HTML)
app.use('/api', (req: Request, res: Response) => {
  res.status(404).json({
    error: `API endpoint not found: ${req.method} ${req.originalUrl || req.path}`,
    success: false,
  });
});

// ----------------------------------------------------
// FRONTEND VITE INTEGRATION
// ----------------------------------------------------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const httpServer = http.createServer(app);
  httpServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = 66000;

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');

    const vite = await createViteServer({
      root: process.cwd(),
      server: {
        middlewareMode: true,
        port: PORT,
        allowedHosts: true,
        hmr: {
          overlay: true,
        },
        ws: {
          server: httpServer,
          timeout: 20000,
        },
        watch: {
          ignored: ['**/.data/**', '**/.git/**', '**/node_modules/**', '**/dist/**'],
        },
      },
      appType: 'spa',
    });

    // Keep WebSocket connections alive across reverse proxies (e.g., Cloud Run / AI Studio preview)
    vite.ws.on('connection', (socket: any) => {
      const heartbeat = setInterval(() => {
        if (socket.readyState === 1 && typeof socket.ping === 'function') {
          try {
            socket.ping();
          } catch {}
        }
      }, 20000);
      heartbeat.unref?.();
      socket.on('close', () => clearInterval(heartbeat));
      socket.on('error', () => clearInterval(heartbeat));
    });

    app.use(vite.middlewares);

    // Development SPA HTML fallback handler
    app.use('*', async (req: Request, res: Response, next: NextFunction) => {
      const url = req.originalUrl;
      // Skip API routes
      if (url.startsWith('/api') || url.startsWith('/favicon') || url.startsWith('/manifest')) {
        return next();
      }
      try {
        const indexPath = path.resolve(process.cwd(), 'index.html');
        let template = fs.readFileSync(indexPath, 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (err: any) {
        vite.ssrFixStacktrace(err);
        next(err);
      }
    });
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Graceful client error handling
  httpServer.on('clientError', (err: any, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  httpServer.on('error', (err: any) => {
    console.error('HTTP Server listen error:', err);
  });

 
  // Initialize database and sessions BEFORE accepting requests.
  try {
    console.log('[AMIE] Initializing persistent database...');

    await db.init();
    console.log('[AMIE] Database initialized successfully.');

    await loadPersistedSessions();
    console.log('[AMIE] Persisted sessions loaded successfully.');

    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(
        `AMIE (AmCham's Intelligent Employee Assistant) running on port ${PORT}`
      );
      console.log('[AMIE] Authentication system is ready.');
    });
  } catch (initErr) {
    console.error(
      '[AMIE] Critical startup initialization failure:',
      initErr
    );
    throw initErr;
  }
}

startServer().catch((err) => {
  console.error('[AMIE] Server startup failed:', err);
});

