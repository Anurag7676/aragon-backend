import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { uploadLimiter } from '../../middleware/rate-limit.js';
import { imagesController } from './images.controller.js';

export const imagesRouter = Router();

imagesRouter.use(authenticate);

imagesRouter.get('/', imagesController.list);
imagesRouter.post('/', uploadLimiter, imagesController.create);
imagesRouter.get('/summary', imagesController.summary);
imagesRouter.get('/events', imagesController.events);
imagesRouter.get('/:id', imagesController.get);
imagesRouter.post('/:id/complete', imagesController.complete);
imagesRouter.delete('/:id', imagesController.remove);
