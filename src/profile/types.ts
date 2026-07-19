import { z } from "zod";

export const WorkHistoryEntry = z.object({
  employer: z.string(),
  title: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  description: z.string(),
});

export const EducationEntry = z.object({
  school: z.string(),
  degree: z.string(),
  field: z.string(),
  graduationYear: z.string(),
});

export const CandidateProfileSchema = z.object({
  fullName: z.string(),
  email: z.string(),
  phone: z.string(),
  location: z.string(),
  linkedinUrl: z.string().optional(),
  websiteUrl: z.string().optional(),
  summary: z.string(),
  skills: z.array(z.string()),
  workHistory: z.array(WorkHistoryEntry),
  education: z.array(EducationEntry),
  workAuthorization: z.string(),
  requiresSponsorship: z.boolean(),
  yearsOfExperience: z.number(),
});

export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;
