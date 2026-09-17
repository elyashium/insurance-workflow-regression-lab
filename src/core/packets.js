/**
 * Packet loading.
 *
 * A packet is a directory of plain-text documents under data/packets/<id>/.
 * Everything is read from disk on demand and indexed for span linking. There
 * is no database: the corpus is small, and keeping it as reviewable text files
 * means a reader can diff the inputs as easily as the outputs.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { indexDocument } from './text.js';
import { DATA_DIR, PACKETS_DIR } from '../paths.js';

/** Canonical document ids, in the order they should be displayed. */
const DOC_ORDER = ['acord', 'sov', 'loss_run', 'endorsement', 'email'];

const DOC_LABELS = {
  acord: 'Application (SYN-125/140)',
  sov: 'Schedule of values',
  loss_run: 'Loss run',
  endorsement: 'Endorsement request',
  email: 'Broker email',
};

/**
 * @typedef {Object} Packet
 * @property {string} packetId
 * @property {string} label
 * @property {string[]} edgeCases
 * @property {import('./text.js').SourceDoc[]} documents
 */

/**
 * List packet ids present on disk, sorted.
 *
 * @returns {Promise<string[]>}
 */
export async function listPacketIds() {
  const entries = await readdir(PACKETS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Load the hand-labeled ground truth file.
 *
 * @returns {Promise<Record<string, any>>}
 */
export async function loadGroundTruth() {
  const raw = await readFile(join(DATA_DIR, 'ground-truth.json'), 'utf8');
  return JSON.parse(raw);
}

/**
 * Load one packet and index every document in it.
 *
 * @param {string} packetId
 * @param {Record<string, any>} [groundTruth] pass to avoid re-reading the file
 * @returns {Promise<Packet>}
 */
export async function loadPacket(packetId, groundTruth) {
  const dir = join(PACKETS_DIR, packetId);
  const files = await readdir(dir);

  const documents = [];
  for (const file of files) {
    if (!file.endsWith('.txt')) continue;
    const docId = file.replace(/\.txt$/, '');
    const text = await readFile(join(dir, file), 'utf8');
    const doc = indexDocument(docId, file, text);
    doc.label = DOC_LABELS[docId] || docId;
    documents.push(doc);
  }

  documents.sort((a, b) => {
    const ia = DOC_ORDER.indexOf(a.docId);
    const ib = DOC_ORDER.indexOf(b.docId);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const gt = groundTruth?.[packetId];
  return {
    packetId,
    label: gt?.label ?? packetId,
    edgeCases: gt?.edgeCases ?? [],
    documents,
  };
}

/**
 * Load every packet in the corpus.
 *
 * @returns {Promise<Packet[]>}
 */
export async function loadAllPackets() {
  const groundTruth = await loadGroundTruth();
  const ids = await listPacketIds();
  return Promise.all(ids.map((id) => loadPacket(id, groundTruth)));
}

/**
 * Look up a document within a packet.
 *
 * @param {Packet} packet
 * @param {string} docId
 * @returns {import('./text.js').SourceDoc | null}
 */
export function doc(packet, docId) {
  return packet.documents.find((d) => d.docId === docId) || null;
}
