import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requirePermission } from '../auth/middleware.js';
import { config } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { idParam, optionalText, parse } from '../lib/validation.js';
import { storeImage } from '../services/media.js';
import {
  addSubmissionNote,
  approveSubmission,
  createSubmission,
  declineSubmission,
  getSubmissionDetail,
  linkDonor,
  listSubmissions,
  requestMoreInfo,
  saveReviewedData,
  submissionSchema,
} from '../services/submissions.js';

export const submissionsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5 } });

submissionsRouter.get('/', async (req, res) => {
  const f = parse(
    z.object({
      status: z.enum(['open', 'pending_review', 'awaiting_donor_info', 'approved', 'declined', 'withdrawn']).optional(),
      event_id: z.coerce.number().int().positive().optional(),
      q: z.string().trim().max(200).optional(),
      mine: z.enum(['true', 'false']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      page_size: z.coerce.number().int().min(1).max(200).default(25),
    }),
    req.query,
  );
  const result = await listSubmissions(req.user!, { ...f, mine: f.mine === 'true', pageSize: f.page_size });
  res.json({ ...result, page: f.page, pageSize: f.page_size });
});

/** Internal "submit on behalf of a donor" - goes into the approval queue like public submissions. */
submissionsRouter.post('/', requirePermission('submissions.create'), upload.single('image'), async (req, res) => {
  let raw: Record<string, unknown>;
  try {
    raw = typeof req.body.data === 'string' ? JSON.parse(req.body.data) : req.body;
  } catch {
    throw badRequest('Invalid submission.');
  }
  const data = parse(submissionSchema, raw);
  const image = req.file ? { ...(await storeImage(req.file.buffer)), originalName: req.file.originalname } : null;
  const key = z.string().uuid().safeParse(raw.idempotency_key);
  const result = await createSubmission({
    data,
    source: 'internal',
    submittedBy: req.user!,
    idempotencyKey: key.success ? key.data : null,
    fingerprint: null,
    image,
  });
  res.status(201).json(result);
});

submissionsRouter.get('/:id', async (req, res) => {
  res.json(await getSubmissionDetail(parse(idParam, req.params.id), req.user!));
});

submissionsRouter.put('/:id/reviewed-data', requirePermission('submissions.review'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  await saveReviewedData(id, req.body, req.user!);
  res.json(await getSubmissionDetail(id, req.user!));
});

submissionsRouter.post('/:id/notes', requirePermission('submissions.review'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const { text } = parse(z.object({ text: z.string() }), req.body);
  await addSubmissionNote(id, text, req.user!);
  res.status(201).json({ ok: true });
});

submissionsRouter.post('/:id/link-donor', requirePermission('submissions.review'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const { donor_id } = parse(z.object({ donor_id: z.coerce.number().int().positive().nullable() }), req.body);
  await linkDonor(id, donor_id, req.user!);
  res.json(await getSubmissionDetail(id, req.user!));
});

submissionsRouter.post('/:id/approve', requirePermission('submissions.review'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  res.json(await approveSubmission(id, req.body, req.user!));
});

submissionsRouter.post('/:id/decline', requirePermission('submissions.review'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const { comment } = parse(z.object({ comment: optionalText(3000) }), req.body ?? {});
  await declineSubmission(id, comment, req.user!);
  res.json(await getSubmissionDetail(id, req.user!));
});

submissionsRouter.post('/:id/request-info', requirePermission('submissions.review'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const { message, send_email } = parse(z.object({ message: z.string(), send_email: z.boolean().default(true) }), req.body);
  const result = await requestMoreInfo(id, message, req.user!, send_email);
  res.json(result);
});
