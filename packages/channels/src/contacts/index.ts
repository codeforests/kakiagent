/**
 * `@kaki/channels/contacts` (FEAT-039 §5): contact identity, merge and undo, and the Contact
 * page's reads. Zod- and SDK-free, so leads imports it without the channel adapters.
 */
export {
  addIdentity,
  attachVerified,
  normaliseIdentity,
  resolveContact,
  type Identity,
  type IdentityKind,
  type IdentitySource,
} from './identity.js';
export {
  ContactNotFound,
  mergeContacts,
  NotMergeable,
  undoMerge,
  UndoBlocked,
  type Moved,
} from './merge.js';
export {
  contactDetail,
  contactLabel,
  duplicateCount,
  duplicatesOf,
  identitiesOf,
  searchContacts,
  shownValue,
  type ChannelContactDetail,
  type MemberNames,
} from './views.js';
