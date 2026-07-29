import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
const db = new PrismaClient();
const initialEmail = "Please confirm your {{role}} assignment for {{eventDate}}";
const initialSms = "Hi {{firstName}}, this is Authentic Moments. Please confirm your {{role}} assignment for {{eventName}} on {{eventDate}} at {{venueName}}. Reply CONFIRM or use this secure link: {{confirmationUrl}}";
const reminderSms = "Authentic Moments reminder: We still need confirmation for your {{role}} assignment on {{eventDate}}. Reply CONFIRM or use: {{confirmationUrl}}";
async function main() {
  const hash = process.env.ADMIN_PASSWORD_HASH || await bcrypt.hash("change-me-before-production", 12);
  await db.administrator.upsert({ where: { email: (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase() }, update: {}, create: { name: "Authentic Moments Administrator", email: (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase(), passwordHash: hash, role: "OWNER" } });
  const policies = [
    ["Initial email",43200,"EMAIL",1,initialEmail,"Please confirm your {{role}} assignment for {{eventDate}}",false],
    ["Initial SMS",43200,"SMS",1,initialSms,null,false],["14-day reminder",20160,"EMAIL",2,initialEmail,"Reminder: Please confirm your {{eventDate}} assignment",false],
    ["7-day reminder",10080,"SMS",3,reminderSms,null,false],["3-day reminder",4320,"EMAIL",4,initialEmail,"Reminder: Please confirm your {{eventDate}} assignment",false],
    ["1-day reminder",1440,"SMS",5,reminderSms,null,false],["Administrator escalation",720,"SYSTEM",6,"Assignment remains unconfirmed.",null,true],
  ] as const;
  for (const [name,offset,channel,attempt,message,subject,escalate] of policies) await db.reminderPolicy.upsert({ where: { name }, update: {}, create: { name, offsetMinutes: offset, channel, attemptNumber: attempt, messageTemplate: message, subjectTemplate: subject, escalate } });
  await db.setting.upsert({ where: { key: "integration:vsco:warning" }, update: {}, create: { key: "integration:vsco:warning", value: "VSCO team assignments must be confirmed against the authenticated V2 API response. Manual assignments remain available." } });
  if (process.env.DEMO_SEED !== "true") return;
  const people = await Promise.all([
    ["Maya","Reed","maya.demo@example.com","+13035550101","PHOTOGRAPHER"],["Jonah","Cole","jonah.demo@example.com","+13035550102","VIDEOGRAPHER"],["Elena","Park","elena.demo@example.com","+13035550103","BOTH"],
  ].map(async ([firstName,lastName,email,phone,role])=>db.person.upsert({where:{normalizedEmail:email},update:{},create:{firstName,lastName,displayName:`${firstName} ${lastName}`,email,normalizedEmail:email,phone,role:role as "PHOTOGRAPHER"}})));
  for (let i=0;i<3;i++){const startsAt=new Date(Date.now()+(20+i*15)*86400000);const event=await db.event.upsert({where:{vscoEventId:`demo-event-${i}`},update:{},create:{vscoEventId:`demo-event-${i}`,name:["Avery & Jordan","Sam & Riley","Taylor & Morgan"][i]!,startsAt,timezone:"America/Denver",venueName:["The Manor House","Denver Botanic Gardens","Moss Denver"][i]!,address:"Denver, CO",rawProviderPayload:{demo:true},lastSyncedAt:new Date()}});await db.assignment.upsert({where:{eventId_personId_role:{eventId:event.id,personId:people[i]!.id,role:i===1?"VIDEOGRAPHER":"PHOTOGRAPHER"}},update:{},create:{eventId:event.id,personId:people[i]!.id,role:i===1?"VIDEOGRAPHER":"PHOTOGRAPHER",source:"VSCO",confirmationStatus:i===0?"CONFIRMED":i===2?"DECLINED":"PENDING",confirmedAt:i===0?new Date():null,declinedAt:i===2?new Date():null}})}
}
main().finally(()=>db.$disconnect());
