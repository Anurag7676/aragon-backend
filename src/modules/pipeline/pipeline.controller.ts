import type { Request, Response } from 'express';
import { currentUserId } from '../../middleware/authenticate.js';
import { imageIdParamsSchema } from '../images/images.schemas.js';
import { pipelineService } from './pipeline.service.js';

export const pipelineController = {
  async get(req: Request, res: Response) {
    const { id } = imageIdParamsSchema.parse(req.params);
    res.json({ pipeline: await pipelineService.get(currentUserId(req), id) });
  },

  async variants(req: Request, res: Response) {
    const { id } = imageIdParamsSchema.parse(req.params);
    res.json(await pipelineService.variants(currentUserId(req), id));
  },

  async reprocess(req: Request, res: Response) {
    const { id } = imageIdParamsSchema.parse(req.params);
    res.status(202).json({ pipeline: await pipelineService.reprocess(currentUserId(req), id) });
  },
};
