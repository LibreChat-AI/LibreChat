const { retrieveAndProcessFile } = require('~/server/services/Files/process');
const { processMessages } = require('./manage');

jest.mock('~/server/services/Files/process', () => ({
  retrieveAndProcessFile: jest.fn(),
}));

describe('processMessages', () => {
  let openai, client;

  beforeEach(() => {
    openai = {};
    client = {
      processedFileIds: new Set(),
    };
    jest.clearAllMocks();
    retrieveAndProcessFile.mockReset();
  });

  test('handles normal case with single source', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value: 'This is a test ^1^ and another^1^',
              annotations: [
                {
                  type: 'file_citation',
                  start_index: 15,
                  end_index: 18,
                  file_citation: { file_id: 'file1' },
                },
                {
                  type: 'file_citation',
                  start_index: 30,
                  end_index: 33,
                  file_citation: { file_id: 'file1' },
                },
              ],
            },
          },
        ],
        created_at: 1,
      },
    ];

    retrieveAndProcessFile.mockResolvedValue({ filename: 'test.txt' });

    const result = await processMessages({ openai, client, messages });

    expect(result.text).toBe('This is a test ^1^ and another^1^\n\n^1.^ test.txt');
    expect(result.edited).toBe(true);
  });

  test('handles multiple different sources', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value: 'This is a test ^1^ and another^2^',
              annotations: [
                {
                  type: 'file_citation',
                  start_index: 15,
                  end_index: 18,
                  file_citation: { file_id: 'file1' },
                },
                {
                  type: 'file_citation',
                  start_index: 30,
                  end_index: 33,
                  file_citation: { file_id: 'file2' },
                },
              ],
            },
          },
        ],
        created_at: 1,
      },
    ];

    retrieveAndProcessFile
      .mockResolvedValueOnce({ filename: 'test1.txt' })
      .mockResolvedValueOnce({ filename: 'test2.txt' });

    const result = await processMessages({ openai, client, messages });

    expect(result.text).toBe('This is a test ^1^ and another^2^\n\n^1.^ test1.txt\n^2.^ test2.txt');
    expect(result.edited).toBe(true);
  });

  test('handles file retrieval failure', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value: 'This is a test ^1^',
              annotations: [
                {
                  type: 'file_citation',
                  start_index: 15,
                  end_index: 18,
                  file_citation: { file_id: 'file1' },
                },
              ],
            },
          },
        ],
        created_at: 1,
      },
    ];

    retrieveAndProcessFile.mockRejectedValue(new Error('File not found'));

    const result = await processMessages({ openai, client, messages });

    expect(result.text).toBe('This is a test ^1^');
    expect(result.edited).toBe(false);
  });

  test('handles citations without file ids', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value: 'This is a test ^1^',
              annotations: [{ type: 'file_citation', start_index: 15, end_index: 18 }],
            },
          },
        ],
        created_at: 1,
      },
    ];

    const result = await processMessages({ openai, client, messages });

    expect(result.text).toBe('This is a test ^1^');
    expect(result.edited).toBe(false);
  });

  test('handles mixed valid and invalid citations', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value: 'This is a test ^1^ and ^2^ and ^3^',
              annotations: [
                {
                  type: 'file_citation',
                  start_index: 15,
                  end_index: 18,
                  file_citation: { file_id: 'file1' },
                },
                { type: 'file_citation', start_index: 23, end_index: 26 },
                {
                  type: 'file_citation',
                  start_index: 31,
                  end_index: 34,
                  file_citation: { file_id: 'file3' },
                },
              ],
            },
          },
        ],
        created_at: 1,
      },
    ];

    retrieveAndProcessFile
      .mockResolvedValueOnce({ filename: 'test1.txt' })
      .mockResolvedValueOnce({ filename: 'test3.txt' });

    const result = await processMessages({ openai, client, messages });

    expect(result.text).toBe(
      'This is a test ^1^ and ^2^ and ^2^\n\n^1.^ test1.txt\n^2.^ test3.txt',
    );
    expect(result.edited).toBe(true);
  });

  test('handles adjacent identical citations', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value: 'This is a test ^1^^1^ and ^1^ ^1^',
              annotations: [
                {
                  type: 'file_citation',
                  start_index: 15,
                  end_index: 18,
                  file_citation: { file_id: 'file1' },
                },
                {
                  type: 'file_citation',
                  start_index: 18,
                  end_index: 21,
                  file_citation: { file_id: 'file1' },
                },
                {
                  type: 'file_citation',
                  start_index: 26,
                  end_index: 29,
                  file_citation: { file_id: 'file1' },
                },
                {
                  type: 'file_citation',
                  start_index: 30,
                  end_index: 33,
                  file_citation: { file_id: 'file1' },
                },
              ],
            },
          },
        ],
        created_at: 1,
      },
    ];

    retrieveAndProcessFile.mockResolvedValue({ filename: 'test.txt' });

    const result = await processMessages({ openai, client, messages });

    expect(result.text).toBe('This is a test ^1^ and ^1^\n\n^1.^ test.txt');
    expect(result.edited).toBe(true);
  });
  test('handles real data with multiple adjacent citations', async () => {
    const messages = [
      {
        id: 'msg_XXXXXXXXXXXXXXXXXXXX',
        object: 'thread.message',
        created_at: 1722980324,
        assistant_id: 'asst_XXXXXXXXXXXXXXXXXXXX',
        thread_id: 'thread_XXXXXXXXXXXXXXXXXXXX',
        run_id: 'run_XXXXXXXXXXXXXXXXXXXX',
        status: 'completed',
        incomplete_details: null,
        incomplete_at: null,
        completed_at: 1722980331,
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: {
              value:
                "The text you have uploaded is from the book \"Harry Potter and the Philosopher's Stone\" by J.K. Rowling. It follows the story of a young boy named Harry Potter who discovers that he is a wizard on his eleventh birthday. Here are some key points of the narrative:\n\n1. **Discovery and Invitation to Hogwarts**: Harry learns that he is a wizard and receives an invitation to attend Hogwarts School of Witchcraft and Wizardry【11:2†source】【11:4†source】.\n\n2. **Shopping for Supplies**: Hagrid takes Harry to Diagon Alley to buy his school supplies, including his wand from Ollivander's【11:9†source】【11:14†source】.\n\n3. **Introduction to Hogwarts**: Harry is introduced to Hogwarts, the magical school where he will learn about magic and discover more about his own background【11:12†source】【11:18†source】.\n\n4. **Meeting Friends and Enemies**: At Hogwarts, Harry makes friends like Ron Weasley and Hermione Granger, and enemies like Draco Malfoy【11:16†source】.\n\n5. **Uncovering the Mystery**: Harry, along with Ron and Hermione, uncovers the mystery of the Philosopher's Stone and its connection to the dark wizard Voldemort【11:1†source】【11:10†source】【11:7†source】.\n\nThese points highlight Harry's initial experiences in the magical world and set the stage for his adventures at Hogwarts.",
              annotations: [
                {
                  type: 'file_citation',
                  text: '【11:2†source】',
                  start_index: 420,
                  end_index: 433,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:4†source】',
                  start_index: 433,
                  end_index: 446,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:9†source】',
                  start_index: 578,
                  end_index: 591,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:14†source】',
                  start_index: 591,
                  end_index: 605,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:12†source】',
                  start_index: 767,
                  end_index: 781,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:18†source】',
                  start_index: 781,
                  end_index: 795,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:16†source】',
                  start_index: 935,
                  end_index: 949,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:1†source】',
                  start_index: 1114,
                  end_index: 1127,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:10†source】',
                  start_index: 1127,
                  end_index: 1141,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:7†source】',
                  start_index: 1141,
                  end_index: 1154,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
              ],
            },
          },
        ],
        attachments: [],
        metadata: {},
        files: [
          {
            object: 'file',
            id: 'file-XXXXXXXXXXXXXXXXXXXX',
            purpose: 'assistants',
            filename: 'hp1.txt',
            bytes: 439742,
            created_at: 1722962139,
            status: 'processed',
            status_details: null,
            type: 'text/plain',
            file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
            filepath:
              'https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-XXXXXXXXXXXXXXXXXXXX/hp1.txt',
            usage: 1,
            user: 'XXXXXXXXXXXXXXXXXXXX',
            context: 'assistants',
            source: 'openai',
            model: 'gpt-4o',
          },
        ],
      },
    ];

    retrieveAndProcessFile.mockResolvedValue({ filename: 'hp1.txt' });

    const result = await processMessages({
      openai: {},
      client: { processedFileIds: new Set() },
      messages,
    });

    const expectedText = `The text you have uploaded is from the book "Harry Potter and the Philosopher's Stone" by J.K. Rowling. It follows the story of a young boy named Harry Potter who discovers that he is a wizard on his eleventh birthday. Here are some key points of the narrative:

1. **Discovery and Invitation to Hogwarts**: Harry learns that he is a wizard and receives an invitation to attend Hogwarts School of Witchcraft and Wizardry^1^.

2. **Shopping for Supplies**: Hagrid takes Harry to Diagon Alley to buy his school supplies, including his wand from Ollivander's^1^.

3. **Introduction to Hogwarts**: Harry is introduced to Hogwarts, the magical school where he will learn about magic and discover more about his own background^1^.

4. **Meeting Friends and Enemies**: At Hogwarts, Harry makes friends like Ron Weasley and Hermione Granger, and enemies like Draco Malfoy^1^.

5. **Uncovering the Mystery**: Harry, along with Ron and Hermione, uncovers the mystery of the Philosopher's Stone and its connection to the dark wizard Voldemort^1^.

These points highlight Harry's initial experiences in the magical world and set the stage for his adventures at Hogwarts.

^1.^ hp1.txt`;

    expect(result.text).toBe(expectedText);
    expect(result.edited).toBe(true);
  });

  test('handles real data with multiple adjacent citations with multiple sources', async () => {
    const messages = [
      {
        id: 'msg_XXXXXXXXXXXXXXXXXXXX',
        object: 'thread.message',
        created_at: 1722980324,
        assistant_id: 'asst_XXXXXXXXXXXXXXXXXXXX',
        thread_id: 'thread_XXXXXXXXXXXXXXXXXXXX',
        run_id: 'run_XXXXXXXXXXXXXXXXXXXX',
        status: 'completed',
        incomplete_details: null,
        incomplete_at: null,
        completed_at: 1722980331,
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: {
              value:
                "The text you have uploaded is from the book \"Harry Potter and the Philosopher's Stone\" by J.K. Rowling. It follows the story of a young boy named Harry Potter who discovers that he is a wizard on his eleventh birthday. Here are some key points of the narrative:\n\n1. **Discovery and Invitation to Hogwarts**: Harry learns that he is a wizard and receives an invitation to attend Hogwarts School of Witchcraft and Wizardry【11:2†source】【11:4†source】.\n\n2. **Shopping for Supplies**: Hagrid takes Harry to Diagon Alley to buy his school supplies, including his wand from Ollivander's【11:9†source】【11:14†source】.\n\n3. **Introduction to Hogwarts**: Harry is introduced to Hogwarts, the magical school where he will learn about magic and discover more about his own background【11:12†source】【11:18†source】.\n\n4. **Meeting Friends and Enemies**: At Hogwarts, Harry makes friends like Ron Weasley and Hermione Granger, and enemies like Draco Malfoy【11:16†source】.\n\n5. **Uncovering the Mystery**: Harry, along with Ron and Hermione, uncovers the mystery of the Philosopher's Stone and its connection to the dark wizard Voldemort【11:1†source】【11:10†source】【11:7†source】.\n\nThese points highlight Harry's initial experiences in the magical world and set the stage for his adventures at Hogwarts.",
              annotations: [
                {
                  type: 'file_citation',
                  text: '【11:2†source】',
                  start_index: 420,
                  end_index: 433,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:4†source】',
                  start_index: 433,
                  end_index: 446,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:9†source】',
                  start_index: 578,
                  end_index: 591,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:14†source】',
                  start_index: 591,
                  end_index: 605,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:12†source】',
                  start_index: 767,
                  end_index: 781,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:18†source】',
                  start_index: 781,
                  end_index: 795,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:16†source】',
                  start_index: 935,
                  end_index: 949,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:1†source】',
                  start_index: 1114,
                  end_index: 1127,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:10†source】',
                  start_index: 1127,
                  end_index: 1141,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_citation',
                  text: '【11:7†source】',
                  start_index: 1141,
                  end_index: 1154,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
              ],
            },
          },
        ],
        attachments: [],
        metadata: {},
        files: [
          {
            object: 'file',
            id: 'file-XXXXXXXXXXXXXXXXXXXX',
            purpose: 'assistants',
            filename: 'hp1.txt',
            bytes: 439742,
            created_at: 1722962139,
            status: 'processed',
            status_details: null,
            type: 'text/plain',
            file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
            filepath:
              'https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-XXXXXXXXXXXXXXXXXXXX/hp1.txt',
            usage: 1,
            user: 'XXXXXXXXXXXXXXXXXXXX',
            context: 'assistants',
            source: 'openai',
            model: 'gpt-4o',
          },
        ],
      },
    ];

    retrieveAndProcessFile.mockResolvedValue({ filename: 'hp1.txt' });

    const result = await processMessages({
      openai: {},
      client: { processedFileIds: new Set() },
      messages,
    });

    const expectedText = `The text you have uploaded is from the book "Harry Potter and the Philosopher's Stone" by J.K. Rowling. It follows the story of a young boy named Harry Potter who discovers that he is a wizard on his eleventh birthday. Here are some key points of the narrative:

1. **Discovery and Invitation to Hogwarts**: Harry learns that he is a wizard and receives an invitation to attend Hogwarts School of Witchcraft and Wizardry^1^.

2. **Shopping for Supplies**: Hagrid takes Harry to Diagon Alley to buy his school supplies, including his wand from Ollivander's^1^.

3. **Introduction to Hogwarts**: Harry is introduced to Hogwarts, the magical school where he will learn about magic and discover more about his own background^1^.

4. **Meeting Friends and Enemies**: At Hogwarts, Harry makes friends like Ron Weasley and Hermione Granger, and enemies like Draco Malfoy^1^.

5. **Uncovering the Mystery**: Harry, along with Ron and Hermione, uncovers the mystery of the Philosopher's Stone and its connection to the dark wizard Voldemort^1^.

These points highlight Harry's initial experiences in the magical world and set the stage for his adventures at Hogwarts.

^1.^ hp1.txt`;

    expect(result.text).toBe(expectedText);
    expect(result.edited).toBe(true);
  });

  test('handles edge case with pre-existing citation-like text', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value:
                "This is a test ^1^ with pre-existing citation-like text. Here's a real citation【11:2†source】.",
              annotations: [
                {
                  type: 'file_citation',
                  text: '【11:2†source】',
                  start_index: 79,
                  end_index: 92,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
              ],
            },
          },
        ],
        created_at: 1,
      },
    ];

    retrieveAndProcessFile.mockResolvedValue({ filename: 'test.txt' });

    const result = await processMessages({
      openai: {},
      client: { processedFileIds: new Set() },
      messages,
    });

    const expectedText =
      "This is a test ^1^ with pre-existing citation-like text. Here's a real citation^1^.\n\n^1.^ test.txt";

    expect(result.text).toBe(expectedText);
    expect(result.edited).toBe(true);
  });

  test('handles FILE_PATH annotation type', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value: 'Here is a file path: [file_path]',
              annotations: [
                {
                  type: 'file_path',
                  text: '[file_path]',
                  start_index: 21,
                  end_index: 32,
                  file_path: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
              ],
            },
          },
        ],
        created_at: 1,
      },
    ];

    retrieveAndProcessFile.mockResolvedValue({
      filename: 'test.txt',
      filepath: '/path/to/test.txt',
    });

    const result = await processMessages({
      openai: {},
      client: { processedFileIds: new Set() },
      messages,
    });

    const expectedText = 'Here is a file path: /path/to/test.txt';

    expect(result.text).toBe(expectedText);
    expect(result.edited).toBe(true);
  });

  test('handles FILE_CITATION annotation type', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value: 'Here is a citation: [citation]',
              annotations: [
                {
                  type: 'file_citation',
                  text: '[citation]',
                  start_index: 20,
                  end_index: 30,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
              ],
            },
          },
        ],
        created_at: 1,
      },
    ];

    retrieveAndProcessFile.mockResolvedValue({ filename: 'test.txt' });

    const result = await processMessages({
      openai: {},
      client: { processedFileIds: new Set() },
      messages,
    });

    const expectedText = 'Here is a citation: ^1^\n\n^1.^ test.txt';

    expect(result.text).toBe(expectedText);
    expect(result.edited).toBe(true);
  });

  test('handles multiple annotation types in a single message', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value:
                'File path: [file_path]. Citation: [citation1]. Another citation: [citation2].',
              annotations: [
                {
                  type: 'file_path',
                  text: '[file_path]',
                  start_index: 11,
                  end_index: 22,
                  file_path: {
                    file_id: 'file-XXXXXXXXXXXXXXXX1',
                  },
                },
                {
                  type: 'file_citation',
                  text: '[citation1]',
                  start_index: 34,
                  end_index: 45,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXX2',
                  },
                },
                {
                  type: 'file_citation',
                  text: '[citation2]',
                  start_index: 65,
                  end_index: 76,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXX3',
                  },
                },
              ],
            },
          },
        ],
        created_at: 1,
      },
    ];

    retrieveAndProcessFile.mockResolvedValueOnce({
      filename: 'file1.txt',
      filepath: '/path/to/file1.txt',
    });
    retrieveAndProcessFile.mockResolvedValueOnce({ filename: 'file2.txt' });
    retrieveAndProcessFile.mockResolvedValueOnce({ filename: 'file3.txt' });

    const result = await processMessages({
      openai: {},
      client: { processedFileIds: new Set() },
      messages,
    });

    const expectedText =
      'File path: /path/to/file1.txt. Citation: ^1^. Another citation: ^2^.\n\n^1.^ file2.txt\n^2.^ file3.txt';

    expect(result.text).toBe(expectedText);
    expect(result.edited).toBe(true);
  });

  test('handles annotation processing failure', async () => {
    const messages = [
      {
        content: [
          {
            type: 'text',
            text: {
              value: 'This citation will fail: [citation]',
              annotations: [
                {
                  type: 'file_citation',
                  text: '[citation]',
                  start_index: 25,
                  end_index: 35,
                  file_citation: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
              ],
            },
          },
        ],
        created_at: 1,
      },
    ];

    retrieveAndProcessFile.mockRejectedValue(new Error('File not found'));

    const result = await processMessages({
      openai: {},
      client: { processedFileIds: new Set() },
      messages,
    });

    const expectedText = 'This citation will fail: [citation]';

    expect(result.text).toBe(expectedText);
    expect(result.edited).toBe(false);
  });

  test('handles multiple FILE_PATH annotations with sandbox links', async () => {
    const messages = [
      {
        id: 'msg_XXXXXXXXXXXXXXXXXXXX',
        object: 'thread.message',
        created_at: 1722983745,
        assistant_id: 'asst_XXXXXXXXXXXXXXXXXXXX',
        thread_id: 'thread_XXXXXXXXXXXXXXXXXXXX',
        run_id: 'run_XXXXXXXXXXXXXXXXXXXX',
        status: 'completed',
        incomplete_details: null,
        incomplete_at: null,
        completed_at: 1722983747,
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: {
              value:
                'I have generated three dummy CSV files for you. You can download them using the links below:\n\n1. [Download Dummy Data 1](sandbox:/mnt/data/dummy_data1.csv)\n2. [Download Dummy Data 2](sandbox:/mnt/data/dummy_data2.csv)\n3. [Download Dummy Data 3](sandbox:/mnt/data/dummy_data3.csv)',
              annotations: [
                {
                  type: 'file_path',
                  text: 'sandbox:/mnt/data/dummy_data1.csv',
                  start_index: 121,
                  end_index: 154,
                  file_path: {
                    file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
                  },
                },
                {
                  type: 'file_path',
                  text: 'sandbox:/mnt/data/dummy_data2.csv',
                  start_index: 183,
                  end_index: 216,
                  file_path: {
                    file_id: 'file-YYYYYYYYYYYYYYYYYYYY',
                  },
                },
                {
                  type: 'file_path',
                  text: 'sandbox:/mnt/data/dummy_data3.csv',
                  start_index: 245,
                  end_index: 278,
                  file_path: {
                    file_id: 'file-ZZZZZZZZZZZZZZZZZZZZ',
                  },
                },
              ],
            },
          },
        ],
        attachments: [
          {
            file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
            tools: [
              {
                type: 'code_interpreter',
              },
            ],
          },
          {
            file_id: 'file-YYYYYYYYYYYYYYYYYYYY',
            tools: [
              {
                type: 'code_interpreter',
              },
            ],
          },
          {
            file_id: 'file-ZZZZZZZZZZZZZZZZZZZZ',
            tools: [
              {
                type: 'code_interpreter',
              },
            ],
          },
        ],
        metadata: {},
        files: [
          {
            object: 'file',
            id: 'file-XXXXXXXXXXXXXXXXXXXX',
            purpose: 'assistants_output',
            filename: 'dummy_data1.csv',
            bytes: 1925,
            created_at: 1722983746,
            status: 'processed',
            status_details: null,
            type: 'text/csv',
            file_id: 'file-XXXXXXXXXXXXXXXXXXXX',
            filepath:
              'https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-XXXXXXXXXXXXXXXXXXXX/dummy_data1.csv',
            usage: 1,
            user: 'XXXXXXXXXXXXXXXXXXXX',
            context: 'assistants_output',
            source: 'openai',
            model: 'gpt-4o-mini',
          },
          {
            object: 'file',
            id: 'file-YYYYYYYYYYYYYYYYYYYY',
            purpose: 'assistants_output',
            filename: 'dummy_data2.csv',
            bytes: 4221,
            created_at: 1722983746,
            status: 'processed',
            status_details: null,
            type: 'text/csv',
            file_id: 'file-YYYYYYYYYYYYYYYYYYYY',
            filepath:
              'https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-YYYYYYYYYYYYYYYYYYYY/dummy_data2.csv',
            usage: 1,
            user: 'XXXXXXXXXXXXXXXXXXXX',
            context: 'assistants_output',
            source: 'openai',
            model: 'gpt-4o-mini',
          },
          {
            object: 'file',
            id: 'file-ZZZZZZZZZZZZZZZZZZZZ',
            purpose: 'assistants_output',
            filename: 'dummy_data3.csv',
            bytes: 3534,
            created_at: 1722983747,
            status: 'processed',
            status_details: null,
            type: 'text/csv',
            file_id: 'file-ZZZZZZZZZZZZZZZZZZZZ',
            filepath:
              'https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-ZZZZZZZZZZZZZZZZZZZZ/dummy_data3.csv',
            usage: 1,
            user: 'XXXXXXXXXXXXXXXXXXXX',
            context: 'assistants_output',
            source: 'openai',
            model: 'gpt-4o-mini',
          },
        ],
      },
    ];

    const mockClient = {
      processedFileIds: new Set(),
    };

    // Mock the retrieveAndProcessFile function for each file
    retrieveAndProcessFile.mockImplementation(({ file_id }) => {
      const fileMap = {
        'file-XXXXXXXXXXXXXXXXXXXX': {
          filename: 'dummy_data1.csv',
          filepath:
            'https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-XXXXXXXXXXXXXXXXXXXX/dummy_data1.csv',
        },
        'file-YYYYYYYYYYYYYYYYYYYY': {
          filename: 'dummy_data2.csv',
          filepath:
            'https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-YYYYYYYYYYYYYYYYYYYY/dummy_data2.csv',
        },
        'file-ZZZZZZZZZZZZZZZZZZZZ': {
          filename: 'dummy_data3.csv',
          filepath:
            'https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-ZZZZZZZZZZZZZZZZZZZZ/dummy_data3.csv',
        },
      };

      return Promise.resolve(fileMap[file_id]);
    });

    const result = await processMessages({ openai: {}, client: mockClient, messages });

    const expectedText =
      'I have generated three dummy CSV files for you. You can download them using the links below:\n\n1. [Download Dummy Data 1](https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-XXXXXXXXXXXXXXXXXXXX/dummy_data1.csv)\n2. [Download Dummy Data 2](https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-YYYYYYYYYYYYYYYYYYYY/dummy_data2.csv)\n3. [Download Dummy Data 3](https://api.openai.com/v1/files/XXXXXXXXXXXXXXXXXXXX/file-ZZZZZZZZZZZZZZZZZZZZ/dummy_data3.csv)';

    expect(result.text).toBe(expectedText);
    expect(result.edited).toBe(true);
  });
});
