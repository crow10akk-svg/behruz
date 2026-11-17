export type BookStatus = 'mavjud' | 'olingan' | 'faol_emas';

export interface Book {
  id: string;
  bookNumber: string;
  title: string;
  author: string;
  category: string;
  description: string;
  coverUrl: string;
  quantity: number;
  availableQuantity?: number;
  status: BookStatus;
  isActive: boolean;
  isDeleted: boolean;
  currentTransactionId?: string;
  currentBorrowerName?: string;
  currentBorrowerGroup?: string;
  currentBorrowerCourse?: string;
  currentBorrowedAt?: string;
  currentDueDate?: string;
  borrowCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Student {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  group: string;
  course: string;
  totalBorrowed: number;
  totalReturned: number;
  activeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FaceProfile {
  id: string;
  nameKey: string;
  groupKey: string;
  firstName: string;
  lastName: string;
  fullName: string;
  group: string;
  course: string;
  facePhotoUrl: string;
  faceDescriptor: number[];
  descriptorHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionRecord {
  id: string;
  bookId: string;
  bookNumber: string;
  bookTitle: string;
  studentId: string;
  studentFirstName: string;
  studentLastName: string;
  studentFullName: string;
  studentGroup: string;
  studentCourse: string;
  type: 'borrow' | 'return';
  status: 'active' | 'returned';
  borrowedAt: string;
  dueDate: string;
  returnedAt?: string;
  borrowSignatureId?: string;
  returnSignatureId?: string;
  faceProfileId?: string;
  adminOverride?: boolean;
  createdAt: string;
}

export interface SignatureRecord {
  id: string;
  transactionId: string;
  studentId: string;
  studentFullName: string;
  bookId: string;
  bookNumber: string;
  actionType: 'borrow' | 'return';
  imageDataUrl: string;
  createdAt: string;
}

export interface AdminCredential {
  username: string;
  passwordHash: string;
  salt: string;
  algorithm: string;
  iterations: number;
  mustChangePassword: boolean;
  updatedAt: string;
}

export interface ActivityLogRecord {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  details: string;
  actor: string;
  createdAt: string;
}

export interface LibrarySetting {
  institutionName: string;
  libraryName: string;
  defaultLoanDays: number;
  lastBackupAt?: string;
  updatedAt: string;
}

export interface OfflinePendingAction {
  id: string;
  kind: 'borrow' | 'return' | 'new-book-borrow';
  createdAt: string;
  payload: {
    bookId: string;
    bookNumber: string;
    bookTitle: string;
    author?: string;
    category?: string;
    quantity?: number;
    coverUrl?: string;
    firstName: string;
    lastName: string;
    group: string;
    course: string;
    borrowedAtIso?: string;
    dueDateIso?: string;
    returnedAtIso?: string;
    signatureDataUrl: string;
    facePhotoUrl?: string;
    faceDescriptor?: number[];
    descriptorHash?: string;
    liveFaceDescriptor?: number[];
    adminOverride?: boolean;
  };
  lastError?: string;
}

export type AdminMenuId =
  | 'dashboard'
  | 'all-books'
  | 'add-book'
  | 'courses-groups'
  | 'borrowers'
  | 'returners'
  | 'currently-holding'
  | 'history'
  | 'students'
  | 'search'
  | 'reports'
  | 'settings';
