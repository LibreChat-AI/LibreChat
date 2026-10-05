import axios from 'axios';
import { uploadMediaURL } from '../src/data-service';

test('hosted reference uploads pass cancellation to the JSON request without changing its content type', async () => {
  const payload = { url: 'https://media.example.com/reference.mp4', role: 'video' as const };
  const response = {
    sourceURL: payload.url,
    file: {
      file_id: 'clip',
      filename: 'reference.mp4',
      filepath: '/media/reference.mp4',
      type: 'video/mp4',
      bytes: 12,
    },
  };
  const post = jest.spyOn(axios, 'post').mockResolvedValueOnce({ data: response });
  const controller = new AbortController();
  try {
    await expect(uploadMediaURL(payload, controller.signal)).resolves.toEqual(response);
    expect(post).toHaveBeenCalledWith('/api/media/uploads/url', JSON.stringify(payload), {
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    post.mockRestore();
  }
});
