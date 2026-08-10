import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { PORTAL_USER_EMAIL } from "../src/lib/authorized-users";
const db = new PrismaClient();
const fourWeekEmail = "Hi {{firstName}},\n\nThis is your 4-week reminder for {{eventName}}.\n\nDate: {{eventDate}}\nLocation: {{eventLocation}}\nRole: {{role}}\n\nPlease confirm your assignment using the secure button below:\n{{confirmationUrl}}";
const twoWeekEmail = "Hi {{firstName}},\n\nReminder: we still need your confirmation for {{eventName}}.\n\nDate: {{eventDate}}\nLocation: {{eventLocation}}\nRole: {{role}}\n\nPlease confirm now using the secure button below:\n{{confirmationUrl}}";
const oneWeekSms = "Authentic Moments: Your event is one week away. {{eventName}} is on {{eventDate}} at {{eventLocation}}. We still need your confirmation: {{confirmationUrl}}";
const threeDayEmail = "Hi {{firstName}},\n\nURGENT: {{eventName}} is only 3 days away and we still need your confirmation.\n\nDate: {{eventDate}}\nLocation: {{eventLocation}}\nRole: {{role}}\n\nPlease confirm immediately:\n{{confirmationUrl}}";
const oneDaySms = "FINAL REMINDER from Authentic Moments: {{eventName}} is tomorrow, {{eventDate}}, at {{eventLocation}}. Please confirm now: {{confirmationUrl}}";
async function main() {
  const projectManagerEmail = process.env.PROJECT_MANAGER_EMAIL?.trim().toLowerCase();
  const projectManagerPassword = process.env.PROJECT_MANAGER_PASSWORD_B64
    ? Buffer.from(process.env.PROJECT_MANAGER_PASSWORD_B64, "base64").toString("utf8")
    : process.env.PROJECT_MANAGER_PASSWORD;
  if (projectManagerEmail && projectManagerEmail !== PORTAL_USER_EMAIL) {
    throw new Error(`PROJECT_MANAGER_EMAIL must be ${PORTAL_USER_EMAIL}`);
  }
  if (projectManagerEmail && projectManagerPassword) {
    const projectManagerHash = await bcrypt.hash(projectManagerPassword, 12);
    await db.administrator.upsert({
      where: { email: projectManagerEmail },
      update: {
        name: process.env.PROJECT_MANAGER_NAME || "Project Manager",
        phone: process.env.PROJECT_MANAGER_PHONE || null,
        passwordHash: projectManagerHash,
        sessionVersion: { increment: 1 },
        role: "PROJECT_MANAGER",
        active: true,
        dailyBriefEnabled: process.env.PROJECT_MANAGER_DAILY_BRIEF_ENABLED !== "false",
        dailyBriefTime: process.env.PROJECT_MANAGER_DAILY_BRIEF_TIME || "08:00",
      },
      create: {
        name: process.env.PROJECT_MANAGER_NAME || "Project Manager",
        email: projectManagerEmail,
        phone: process.env.PROJECT_MANAGER_PHONE || null,
        passwordHash: projectManagerHash,
        role: "PROJECT_MANAGER",
        dailyBriefEnabled: process.env.PROJECT_MANAGER_DAILY_BRIEF_ENABLED !== "false",
        dailyBriefTime: process.env.PROJECT_MANAGER_DAILY_BRIEF_TIME || "08:00",
      },
    });
  }
  const policies = [
    ["4-week confirmation email",40320,"EMAIL",1,fourWeekEmail,"Please confirm your {{role}} assignment for {{eventDate}} at {{eventLocation}}",false],
    ["14-day email reminder",20160,"EMAIL",2,twoWeekEmail,"Reminder: confirmation needed for {{eventDate}} at {{eventLocation}}",false],
    ["7-day text reminder",10080,"SMS",3,oneWeekSms,null,false],
    ["3-day urgent email",4320,"EMAIL",4,threeDayEmail,"URGENT: Please confirm your {{eventDate}} assignment",false],
    ["1-day final text",1440,"SMS",5,oneDaySms,null,false],
  ] as const;
  await db.reminderPolicy.updateMany({
    where: { name: { notIn: policies.map(([name]) => name) } },
    data: { active: false },
  });
  await db.plannedAction.updateMany({
    where: {
      reason: { notIn: policies.map(([name]) => name) },
      status: { in: ["PLANNED", "QUEUED", "WAITING_FOR_APPROVAL"] },
    },
    data: { status: "CANCELED", canceledAt: new Date() },
  });
  for (const [name,offset,channel,attempt,message,subject,escalate] of policies) await db.reminderPolicy.upsert({
    where: { name },
    update: { active: true, offsetMinutes: offset, channel, attemptNumber: attempt, messageTemplate: message, subjectTemplate: subject, escalate },
    create: { name, offsetMinutes: offset, channel, attemptNumber: attempt, messageTemplate: message, subjectTemplate: subject, escalate },
  });
  await db.setting.upsert({ where: { key: "integration:vsco:warning" }, update: {}, create: { key: "integration:vsco:warning", value: "VSCO team assignments must be confirmed against the authenticated V2 API response. Manual assignments remain available." } });
  if (process.env.DEMO_SEED !== "true") return;
  const people = await Promise.all([
    ["Maya","Reed","maya.demo@example.com","+13035550101","PHOTOGRAPHER"],["Jonah","Cole","jonah.demo@example.com","+13035550102","VIDEOGRAPHER"],["Elena","Park","elena.demo@example.com","+13035550103","BOTH"],
  ].map(async ([firstName,lastName,email,phone,role])=>db.person.upsert({where:{normalizedEmail:email},update:{},create:{firstName,lastName,displayName:`${firstName} ${lastName}`,email,normalizedEmail:email,phone,role:role as "PHOTOGRAPHER"}})));
  for (let i=0;i<3;i++){const startsAt=new Date(Date.now()+(20+i*15)*86400000);const event=await db.event.upsert({where:{vscoEventId:`demo-event-${i}`},update:{},create:{vscoEventId:`demo-event-${i}`,name:["Avery & Jordan","Sam & Riley","Taylor & Morgan"][i]!,startsAt,timezone:"America/Denver",venueName:["The Manor House","Denver Botanic Gardens","Moss Denver"][i]!,address:"Denver, CO",rawProviderPayload:{demo:true},lastSyncedAt:new Date()}});await db.assignment.upsert({where:{eventId_personId_role:{eventId:event.id,personId:people[i]!.id,role:i===1?"VIDEOGRAPHER":"PHOTOGRAPHER"}},update:{},create:{eventId:event.id,personId:people[i]!.id,role:i===1?"VIDEOGRAPHER":"PHOTOGRAPHER",source:"VSCO",confirmationStatus:i===0?"CONFIRMED":i===2?"DECLINED":"PENDING",confirmedAt:i===0?new Date():null,declinedAt:i===2?new Date():null}})}
}
main().finally(()=>db.$disconnect());
