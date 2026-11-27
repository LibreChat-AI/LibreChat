import type { TConversationTagsResponse } from 'librechat-data-provider';
import { updateConversationTag } from './conversationTags';

describe('ConversationTag Utilities', () => {
  let conversations: TConversationTagsResponse;

  beforeEach(() => {
    conversations = [
      {
        _id: 'tag-id-saved',
        tag: 'saved',
        count: 1,
        position: 0,
        description: 'description1',
        updatedAt: '2023-04-01T12:00:00Z',
        createdAt: '2023-04-01T12:00:00Z',
        user: 'user1',
      },
      {
        _id: 'tag-id-1',
        tag: 'tag1',
        count: 1,
        position: 1,
        description: 'description1',
        updatedAt: '2023-04-01T12:00:00Z',
        createdAt: '2023-04-01T12:00:00Z',
        user: 'user1',
      },
      {
        _id: 'tag-id-2',
        tag: 'tag2',
        count: 20,
        position: 2,
        description: 'description2',
        updatedAt: new Date().toISOString(),
        createdAt: '2023-04-01T12:00:00Z',
        user: 'user1',
      },
      {
        _id: 'tag-id-3',
        tag: 'tag3',
        count: 30,
        position: 3,
        description: 'description3',
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        user: 'user1',
      },
      {
        _id: 'tag-id-4',
        tag: 'tag4',
        count: 40,
        position: 4,
        description: 'description4',
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        user: 'user1',
      },
      {
        _id: 'tag-id-5',
        tag: 'tag5',
        count: 50,
        position: 5,
        description: 'description5',
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        user: 'user1',
      },
    ];
  });

  describe('updateConversationTag', () => {
    it('updates the first tag correctly', () => {
      const updated = updateConversationTag(
        conversations,
        { tag: 'tag1-new', description: 'description1-new' },
        {
          ...conversations[1],
          tag: 'tag1-new',
          description: 'description1-new',
        },
        'tag1',
      );

      expect(updated[0].tag).toBe('saved');
      expect(updated[0].position).toBe(0);
      expect(updated[1].tag).toBe('tag1-new');
      expect(updated[1].description).toBe('description1-new');
      expect(updated[1].position).toBe(1);
      expect(updated[2].tag).toBe('tag2');
      expect(updated[2].position).toBe(2);
      expect(updated[3].tag).toBe('tag3');
      expect(updated[3].position).toBe(3);
      expect(updated[4].tag).toBe('tag4');
      expect(updated[4].position).toBe(4);
      expect(updated[5].tag).toBe('tag5');
      expect(updated[5].position).toBe(5);
    });
  });
  it('updates the third tag correctly', () => {
    const updated = updateConversationTag(
      conversations,
      { tag: 'tag3-new', description: 'description3-new' },
      {
        ...conversations[3],
        tag: 'tag3-new',
        description: 'description3-new',
      },
      'tag3',
    );

    expect(updated[0].tag).toBe('saved');
    expect(updated[0].position).toBe(0);
    expect(updated[1].tag).toBe('tag1');
    expect(updated[1].position).toBe(1);
    expect(updated[2].tag).toBe('tag2');
    expect(updated[2].position).toBe(2);
    expect(updated[3].tag).toBe('tag3-new');
    expect(updated[3].description).toBe('description3-new');
    expect(updated[3].position).toBe(3);
    expect(updated[4].tag).toBe('tag4');
    expect(updated[4].position).toBe(4);
    expect(updated[5].tag).toBe('tag5');
    expect(updated[5].position).toBe(5);
  });

  it('updates the order of other tags if the order of the tags is moving up', () => {
    const updated = updateConversationTag(
      conversations,
      // move tag3 to the second position
      { position: 2 },
      {
        ...conversations[3],
        position: 2,
      },
      'tag3',
    );

    expect(updated[0].tag).toBe('saved');
    expect(updated[0].position).toBe(0);
    expect(updated[1].tag).toBe('tag1');
    expect(updated[1].position).toBe(1);
    expect(updated[2].tag).toBe('tag3');
    expect(updated[2].position).toBe(2);
    expect(updated[3].tag).toBe('tag2');
    expect(updated[3].position).toBe(3);
    expect(updated[4].tag).toBe('tag4');
    expect(updated[4].position).toBe(4);
    expect(updated[5].tag).toBe('tag5');
    expect(updated[5].position).toBe(5);
  });

  it('updates the order of other tags if the order of the tags is moving down', () => {
    const updated = updateConversationTag(
      conversations,
      // move tag3 to the last position
      { position: 5 },
      {
        ...conversations[3],
        position: 5,
      },
      'tag3',
    );

    expect(updated[0].tag).toBe('saved');
    expect(updated[0].position).toBe(0);
    expect(updated[1].tag).toBe('tag1');
    expect(updated[1].position).toBe(1);
    expect(updated[2].tag).toBe('tag2');
    expect(updated[2].position).toBe(2);
    expect(updated[3].tag).toBe('tag4');
    expect(updated[3].position).toBe(3);
    expect(updated[4].tag).toBe('tag5');
    expect(updated[4].position).toBe(4);
    expect(updated[5].tag).toBe('tag3');
    expect(updated[5].position).toBe(5);
  });

  it('updates the order of other tags if new tag is added', () => {
    const updated = updateConversationTag(
      conversations,
      { tag: 'newtag', description: 'newDescription' },
      {
        _id: 'tag-id-newtag',
        tag: 'newtag',
        description: 'newDescription',
        position: 1,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        user: 'user1',
        count: 30,
      },
      // no tag tag specified
    );

    expect(updated[0].tag).toBe('saved');
    expect(updated[0].position).toBe(0);
    expect(updated[1].tag).toBe('newtag');
    expect(updated[1].description).toBe('newDescription');
    expect(updated[1].position).toBe(1);
    expect(updated[2].tag).toBe('tag1');
    expect(updated[2].position).toBe(2);
    expect(updated[3].tag).toBe('tag2');
    expect(updated[3].position).toBe(3);
    expect(updated[4].tag).toBe('tag3');
    expect(updated[4].position).toBe(4);
    expect(updated[5].tag).toBe('tag4');
    expect(updated[5].position).toBe(5);
    expect(updated[6].tag).toBe('tag5');
    expect(updated[6].position).toBe(6);
  });

  it('returns a new array for new tag if no tags exist', () => {
    const updated = updateConversationTag(
      [],
      { tag: 'newtag', description: 'newDescription' },
      {
        _id: 'tag-id-saved',
        tag: 'saved',
        description: 'newDescription',
        position: 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        user: 'user1',
        count: 30,
      },
      // no tag tag specified
    );
    expect(updated.length).toBe(1);
    expect(updated[0].tag).toBe('saved');
    expect(updated[0].position).toBe(0);
  });
});
