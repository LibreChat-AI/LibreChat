const { createHash } = require('crypto');

const DELIVERY = 'E2E_RUN_FILE_DELIVERY:';
const NESTED = 'E2E_RUN_FILE_NESTED:';
const RECIPIENTS = 'E2E_RUN_FILE_RECIPIENTS:';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('\n');
}

function messageType(message) {
  return message.getType?.() ?? message._getType?.() ?? message.role ?? message.type;
}

function markerValue(text, marker) {
  const index = text.indexOf(marker);
  return index < 0
    ? ''
    : text
        .slice(index + marker.length)
        .trim()
        .split(/\s+/, 1)[0];
}

function childPrompt(messages, marker) {
  return messages.some(
    (message) =>
      ['human', 'user'].includes(messageType(message)) &&
      contentText(message.content).includes(marker),
  );
}

function toolId(label, phase) {
  return `call_e2e_run_file_delivery_${label}_${phase}`;
}

function toolResult(messages, label, phase) {
  return messages.findLast(
    (message) => messageType(message) === 'tool' && message.tool_call_id === toolId(label, phase),
  );
}

function call(label, phase, name, args = {}) {
  return {
    response: '',
    toolCalls: [{ id: toolId(label, phase), name, args, type: 'tool_call' }],
  };
}

function delegate(label, phase, agentId, description) {
  return call(label, phase, 'subagent', { subagent_type: agentId, description });
}

function parsedResult(message) {
  return JSON.parse(contentText(message.content));
}

function requireCatalog(message, fileIds) {
  const catalog = parsedResult(message);
  const actualIds = catalog.files.map((file) => file.file_id).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify([...fileIds].sort())) {
    throw new Error(`Unexpected shared-file catalog: ${JSON.stringify(catalog)}`);
  }
  return catalog;
}

function requireResult(message, expected) {
  const result = contentText(message?.content);
  if (!result.includes(expected)) {
    throw new Error(`Expected ${expected}; received ${result}`);
  }
  return result;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function providerDocuments(messages) {
  return messages.flatMap((message) => {
    if (!['human', 'user'].includes(messageType(message)) || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.flatMap((part) => {
      const file = part.type === 'file' ? part.file : part;
      if (part.type !== 'file' && part.type !== 'input_file') return [];
      const encoded = file?.file_data?.match(/^data:application\/pdf;base64,(.+)$/);
      return encoded ? [{ filename: file.filename, bytes: Buffer.from(encoded[1], 'base64') }] : [];
    });
  });
}

function extractedFileText(messages, filename) {
  const heading = `# "${filename}"\n`;
  for (const message of messages) {
    if (!['human', 'user'].includes(messageType(message))) continue;
    const text = contentText(message.content);
    const start = text.indexOf(heading);
    if (start < 0) continue;
    return text
      .slice(start + heading.length)
      .split(/\n```|\n\n---\n\n/, 1)[0]
      .trimEnd();
  }
  throw new Error(`No extracted text for ${filename} reached the child model`);
}

function deliveryResponses(value) {
  const [childId, label, pdfId, textId, pdfHash, textHash] = value.split(':');
  const prompt = `E2E_RUN_FILE_DELIVERY_CHILD:${label}`;
  const complete = `E2E run file delivery verified ${label} pdf=${pdfHash} text=${textHash}`;
  return {
    responses: [''],
    overrideSubagentModel: true,
    resolveInvocation(messages) {
      if (!childPrompt(messages, prompt)) {
        const result = toolResult(messages, label, 'delivery_child');
        if (!result) return delegate(label, 'delivery_child', childId, prompt);
        return { response: requireResult(result, complete) };
      }
      const catalog = toolResult(messages, label, 'delivery_catalog');
      if (!catalog) return call(label, 'delivery_catalog', 'list_run_files');
      requireCatalog(catalog, [pdfId, textId]);
      const documents = providerDocuments(messages);
      const pdfName = `e2e-delivery-${label}.pdf`;
      const textName = `e2e-delivery-${label}.txt`;
      if (documents.length !== 1 || documents[0].filename !== pdfName) {
        throw new Error(`Expected one provider PDF in child messages; got ${documents.length}`);
      }
      const actualPdfHash = sha256(documents[0].bytes);
      const actualTextHash = sha256(extractedFileText(messages, textName));
      if (actualPdfHash !== pdfHash || actualTextHash !== textHash) {
        throw new Error(`Child input bytes differ: pdf=${actualPdfHash} text=${actualTextHash}`);
      }
      return { response: complete };
    },
  };
}

function nestedResponses(value) {
  const [middleId, leafId, outsiderId, label, inputId] = value.split(':');
  const middlePrompt = `E2E_RUN_FILE_NESTED_MIDDLE:${label}`;
  const leafPrompt = `E2E_RUN_FILE_NESTED_LEAF:${label}`;
  const leafComplete = `E2E nested leaf verified ${label} file=${inputId}`;
  const middleComplete = `E2E nested middle verified ${label} file=${inputId}`;
  return {
    responses: [''],
    overrideSubagentModel: true,
    resolveInvocation(messages) {
      if (childPrompt(messages, leafPrompt)) {
        const catalog = toolResult(messages, label, 'leaf_catalog');
        if (!catalog) return call(label, 'leaf_catalog', 'list_run_files');
        const evidence = {
          toolCallId: catalog.tool_call_id,
          catalog: requireCatalog(catalog, [inputId]),
        };
        return { response: `${leafComplete}\nE2E_LEAF_CATALOG:${JSON.stringify(evidence)}` };
      }
      if (childPrompt(messages, middlePrompt)) {
        const catalog = toolResult(messages, label, 'middle_catalog');
        if (!catalog) return call(label, 'middle_catalog', 'list_run_files');
        requireCatalog(catalog, [inputId]);
        const result = toolResult(messages, label, 'leaf_child');
        if (!result) return delegate(label, 'leaf_child', leafId, leafPrompt);
        requireResult(result, leafComplete);
        return { response: middleComplete };
      }
      const rejected = toolResult(messages, label, 'outsider_child');
      if (!rejected) {
        return delegate(label, 'outsider_child', outsiderId, `E2E_UNAUTHORIZED_CHILD:${label}`);
      }
      requireResult(rejected, 'Received tool input did not match expected schema');
      const result = toolResult(messages, label, 'middle_child');
      if (!result) return delegate(label, 'middle_child', middleId, middlePrompt);
      requireResult(result, middleComplete);
      return { response: `E2E nested sharing complete ${label} file=${inputId}` };
    },
  };
}

function recipientResponses(value) {
  const [producerId, readerId, observerId, outsiderId, label, inputId] = value.split(':');
  const producerPrompt = `E2E_RUN_FILE_PRODUCER:${label}`;
  const readerPrompt = `E2E_RUN_FILE_READER:${label}`;
  const observerPrompt = `E2E_RUN_FILE_OBSERVER:${label}`;
  const outputName = `e2e-run-files-${label}.csv`;
  return {
    responses: [''],
    overrideSubagentModel: true,
    resolveInvocation(messages) {
      if (childPrompt(messages, producerPrompt)) {
        const inputCatalog = toolResult(messages, label, 'producer_inputs');
        if (!inputCatalog) return call(label, 'producer_inputs', 'list_run_files');
        requireCatalog(inputCatalog, [inputId]);
        const write = toolResult(messages, label, 'producer_write');
        if (!write) {
          return call(label, 'producer_write', 'bash_tool', {
            command: `echo E2E_RUN_FILE_ARTIFACT:${label}`,
          });
        }
        const privateCatalog = toolResult(messages, label, 'producer_private');
        if (!privateCatalog) return call(label, 'producer_private', 'list_run_files');
        const artifact = requireCatalog(privateCatalog, [inputId]).artifacts.find(
          (entry) => entry.filename === outputName,
        );
        if (!artifact) throw new Error('Producer output has no private artifact ID');
        const rejected = toolResult(messages, label, 'publish_outsider');
        if (!rejected) {
          return call(label, 'publish_outsider', 'publish_artifact', {
            artifact_id: artifact.artifact_id,
            recipient_agent_ids: [outsiderId],
          });
        }
        requireResult(rejected, 'sharing policy does not authorize');
        const retryCatalog = toolResult(messages, label, 'producer_retry');
        if (!retryCatalog) return call(label, 'producer_retry', 'list_run_files');
        const retained = requireCatalog(retryCatalog, [inputId]).artifacts;
        if (!retained.some((entry) => entry.artifact_id === artifact.artifact_id)) {
          throw new Error('Rejected recipients consumed the private artifact');
        }
        const published = toolResult(messages, label, 'publish_reader');
        if (!published) {
          return call(label, 'publish_reader', 'publish_artifact', {
            artifact_id: artifact.artifact_id,
            recipient_agent_ids: [readerId],
          });
        }
        const file = parsedResult(published);
        if (!file.file_id || file.filename !== outputName) {
          throw new Error('Publication did not return the durable output identity');
        }
        return { response: `E2E recipient publication ${label} file=${file.file_id}` };
      }
      if (childPrompt(messages, observerPrompt)) {
        const catalog = toolResult(messages, label, 'observer_catalog');
        if (!catalog) return call(label, 'observer_catalog', 'list_run_files');
        const observed = requireCatalog(catalog, [inputId]);
        if (observed.artifacts.length !== 0) throw new Error('Observer can see private artifacts');
        return { response: `E2E observer isolated ${label}` };
      }
      if (childPrompt(messages, readerPrompt)) {
        const catalog = toolResult(messages, label, 'reader_catalog');
        if (!catalog) return call(label, 'reader_catalog', 'list_run_files');
        const files = parsedResult(catalog).files;
        const file = files.find((entry) => entry.filename === outputName);
        if (!file) throw new Error('Named sibling recipient cannot see the publication');
        requireCatalog(catalog, [inputId, file.file_id]);
        const search = toolResult(messages, label, 'reader_search');
        if (!search) return call(label, 'reader_search', 'file_search', { query: outputName });
        requireResult(search, 'No content found in the files.');
        return { response: `E2E reader searched ${label} file=${file.file_id}` };
      }
      const produced = toolResult(messages, label, 'producer_child');
      if (!produced) return delegate(label, 'producer_child', producerId, producerPrompt);
      const fileId = contentText(produced.content).match(/file=([\w-]+)/)?.[1];
      if (!fileId) throw new Error('Producer returned no published file ID');
      const observer = toolResult(messages, label, 'observer_child');
      if (!observer) return delegate(label, 'observer_child', observerId, observerPrompt);
      requireResult(observer, `E2E observer isolated ${label}`);
      const reader = toolResult(messages, label, 'reader_child');
      if (!reader) return delegate(label, 'reader_child', readerId, readerPrompt);
      requireResult(reader, `E2E reader searched ${label} file=${fileId}`);
      const catalog = toolResult(messages, label, 'recipient_parent_catalog');
      if (!catalog) return call(label, 'recipient_parent_catalog', 'list_run_files');
      requireCatalog(catalog, [inputId, fileId]);
      return { response: `E2E recipient sharing complete ${label} file=${fileId}` };
    },
  };
}

function runFileDeliveryResponses(text) {
  const delivery = markerValue(text, DELIVERY);
  if (delivery) return deliveryResponses(delivery);
  const nested = markerValue(text, NESTED);
  if (nested) return nestedResponses(nested);
  const recipients = markerValue(text, RECIPIENTS);
  return recipients ? recipientResponses(recipients) : null;
}

module.exports = { runFileDeliveryResponses };
