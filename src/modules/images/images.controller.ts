import type { Request, Response } from 'express';
import { currentUserId } from '../../middleware/authenticate.js';
import { imageEventHub } from './image-events.js';
import { createImageSchema, imageIdParamsSchema, listImagesQuerySchema } from './images.schemas.js';
import { imagesService } from './images.service.js';

export const imagesController = {
  async create(req: Request, res: Response) {
    const result = await imagesService.createUpload(currentUserId(req), createImageSchema.parse(req.body));
    res.status(201).location(`/api/v1/images/${result.image.id}`).json(result);
  },

  async complete(req: Request, res: Response) {
    const { id } = imageIdParamsSchema.parse(req.params);
    res.status(202).json({ image: await imagesService.completeUpload(currentUserId(req), id) });
  },

  async list(req: Request, res: Response) {
    res.json(await imagesService.list(currentUserId(req), listImagesQuerySchema.parse(req.query)));
  },

  async summary(req: Request, res: Response) {
    res.json(await imagesService.summary(currentUserId(req)));
  },

  async get(req: Request, res: Response) {
    const { id } = imageIdParamsSchema.parse(req.params);
    res.json({ image: await imagesService.get(currentUserId(req), id) });
  },

  async remove(req: Request, res: Response) {
    const { id } = imageIdParamsSchema.parse(req.params);
    await imagesService.remove(currentUserId(req), id);
    res.status(204).end();
  },

  async events(req: Request, res: Response) {
    await imageEventHub.attach(currentUserId(req), req, res);
  },
};
