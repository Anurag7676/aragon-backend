/** Why a photo was rejected. Codes are stored on the image; labels and messages are shown to the user. */
export const REJECTION_REASONS = {
  UNSUPPORTED_FORMAT: {
    label: 'Unsupported file type',
    message: 'Only JPG, PNG and HEIC photos are accepted. This file is a different format.',
  },
  UNREADABLE_FILE: {
    label: "Couldn't read photo",
    message: 'This file looks damaged or is too large to process. Try exporting it again as JPG.',
  },
  FILE_TOO_SMALL: {
    label: 'File too small',
    message: 'This file is too small to be a usable photo. Upload the original instead of a compressed copy.',
  },
  RESOLUTION_TOO_LOW: {
    label: 'Resolution too low',
    message: 'The photo needs to be at least 512 pixels on its shortest side.',
  },
  BLURRY: {
    label: 'Blurry face detected',
    message: 'Your face is out of focus. Use a sharp, well-lit photo.',
  },
  NO_FACE: {
    label: 'No face found',
    message: "We couldn't find a face. Make sure your face is clearly visible and facing the camera.",
  },
  FACE_TOO_SMALL: {
    label: 'Face is too far away',
    message: 'Your face is too small in this photo. Move closer to the camera or crop the photo.',
  },
  MULTIPLE_FACES: {
    label: 'Multiple faces',
    message: 'More than one face was found. Upload photos with only you in them.',
  },
  TOO_SIMILAR: {
    label: 'Too similar to another upload',
    message: "You've already uploaded a very similar photo. Use different backgrounds, lighting and clothing.",
  },
} as const;

export type RejectionCode = keyof typeof REJECTION_REASONS;

export interface RejectionReasonDto {
  code: RejectionCode;
  label: string;
  message: string;
}

export const describeRejection = (code: string): RejectionReasonDto | null =>
  code in REJECTION_REASONS ? { code: code as RejectionCode, ...REJECTION_REASONS[code as RejectionCode] } : null;
