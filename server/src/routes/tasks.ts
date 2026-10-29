import { Router } from 'express';
import { idParam, parse } from '../lib/validation.js';
import { applyTaskAction, createTask, getTask, listTasks } from '../services/tasks.js';

export const tasksRouter = Router();

tasksRouter.get('/', async (req, res) => {
  res.json(await listTasks(req.user!, req.query));
});

tasksRouter.post('/', async (req, res) => {
  res.status(201).json(await createTask(req.body, req.user!));
});

tasksRouter.get('/:id', async (req, res) => {
  res.json(await getTask(parse(idParam, req.params.id), req.user!));
});

tasksRouter.post('/:id/actions', async (req, res) => {
  const id = parse(idParam, req.params.id);
  await applyTaskAction(id, req.body, req.user!);
  res.json(await getTask(id, req.user!));
});
