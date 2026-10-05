import { relations } from "drizzle-orm";
import { permissions, rolePermissions, roles, users } from "./auth";
import { catalogItems, categories, customerContacts, customers, providers } from "./commercial";
import { exchangeRates } from "./finance";
import { generatedDocuments } from "./infra";
import {
  quotationItems,
  quotationReviews,
  quotationRevisions,
  quotationStatusHistory,
  quotations,
} from "./quotations";

// ORM query graph only; integrity lives in the table FKs/constraints.
// Tables with several FKs to the same parent use relationName to disambiguate.

export const rolesRelations = relations(roles, ({ many }) => ({
  users: many(users),
  rolePermissions: many(rolePermissions),
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
  rolePermissions: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  role: one(roles, { fields: [users.roleId], references: [roles.id] }),
  ownedCustomers: many(customers, { relationName: "customerOwner" }),
  ownedQuotations: many(quotations, { relationName: "quotationOwner" }),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  owner: one(users, {
    fields: [customers.ownerUserId],
    references: [users.id],
    relationName: "customerOwner",
  }),
  createdBy: one(users, {
    fields: [customers.createdByUserId],
    references: [users.id],
    relationName: "customerCreator",
  }),
  contacts: many(customerContacts),
  quotations: many(quotations),
}));

export const customerContactsRelations = relations(customerContacts, ({ one }) => ({
  customer: one(customers, {
    fields: [customerContacts.customerId],
    references: [customers.id],
  }),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  catalogItems: many(catalogItems),
}));

export const catalogItemsRelations = relations(catalogItems, ({ one }) => ({
  category: one(categories, {
    fields: [catalogItems.categoryId],
    references: [categories.id],
  }),
}));

export const quotationsRelations = relations(quotations, ({ one, many }) => ({
  customer: one(customers, { fields: [quotations.customerId], references: [customers.id] }),
  owner: one(users, {
    fields: [quotations.ownerUserId],
    references: [users.id],
    relationName: "quotationOwner",
  }),
  createdBy: one(users, {
    fields: [quotations.createdByUserId],
    references: [users.id],
    relationName: "quotationCreator",
  }),
  revisions: many(quotationRevisions),
  statusHistory: many(quotationStatusHistory),
}));

export const quotationRevisionsRelations = relations(quotationRevisions, ({ one, many }) => ({
  quotation: one(quotations, {
    fields: [quotationRevisions.quotationId],
    references: [quotations.id],
  }),
  exchangeRate: one(exchangeRates, {
    fields: [quotationRevisions.exchangeRateId],
    references: [exchangeRates.id],
  }),
  items: many(quotationItems),
  reviews: many(quotationReviews),
  documents: many(generatedDocuments),
}));

export const quotationItemsRelations = relations(quotationItems, ({ one }) => ({
  revision: one(quotationRevisions, {
    fields: [quotationItems.revisionId],
    references: [quotationRevisions.id],
  }),
  catalogItem: one(catalogItems, {
    fields: [quotationItems.catalogItemId],
    references: [catalogItems.id],
  }),
  provider: one(providers, {
    fields: [quotationItems.providerId],
    references: [providers.id],
  }),
}));

export const quotationStatusHistoryRelations = relations(quotationStatusHistory, ({ one }) => ({
  quotation: one(quotations, {
    fields: [quotationStatusHistory.quotationId],
    references: [quotations.id],
  }),
}));

export const quotationReviewsRelations = relations(quotationReviews, ({ one }) => ({
  revision: one(quotationRevisions, {
    fields: [quotationReviews.revisionId],
    references: [quotationRevisions.id],
  }),
}));

export const generatedDocumentsRelations = relations(generatedDocuments, ({ one }) => ({
  revision: one(quotationRevisions, {
    fields: [generatedDocuments.revisionId],
    references: [quotationRevisions.id],
  }),
}));
