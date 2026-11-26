// Recall: turning text into vectors and finding the nearest ones. Nothing here reads the
// environment; settings arrive as plain values.
export { DEFAULT_HASH_DIMENSIONS, type EmbedOptions, type Embeddings, HashEmbeddings, hashTokens } from "./embeddings.ts";
export { RecallError, type RecallErrorCode, type RecallErrorInit } from "./errors.ts";
export {
  DEFAULT_EMBED_BATCH_SIZE,
  DEFAULT_OPENAI_BASE_URL,
  OpenAIEmbeddings,
  type OpenAIEmbeddingsSettings,
} from "./openai_embeddings.ts";
export {
  type JsonObject,
  type JsonValue,
  type SearchHit,
  type SearchOptions,
  VectorIndex,
  type VectorPoint,
} from "./vector_index.ts";
