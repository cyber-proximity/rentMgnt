const { PrismaClient } = require('@prisma/client');
const { formatMoney } = require('./currency');

const prisma = new PrismaClient();

const UPCOMING_DAYS = 3;

function getRentDueDay(tenant) {
  if (tenant.leaseStart) {
    return Math.min(new Date(tenant.leaseStart).getDate(), 28);
  }
  return 1;
}

function getDueDateForMonth(year, month, dueDay) {
  return new Date(year, month, dueDay);
}

function daysBetween(a, b) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.ceil((b - a) / msPerDay);
}

// dedupeKey must be a substring that actually appears in `message` (e.g. the
// tenant's name or their room label) — matching on something absent from
// every stored message (like a raw id) would make this check always miss.
async function hasRecentNotification(userId, type, dedupeKey) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      type,
      message: { contains: dedupeKey },
      createdAt: { gte: since },
    },
  });
  return Boolean(existing);
}

async function createNotificationIfNew(userId, type, title, message, dedupeKey) {
  if (await hasRecentNotification(userId, type, dedupeKey)) return false;
  await prisma.notification.create({ data: { userId, type, title, message } });
  return true;
}

async function processTenantRent(tenant, now) {
  if (!tenant.roomId || !tenant.room) return [];

  const rent = tenant.room.rentAmount || 0;
  if (rent <= 0) return [];

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const paid = tenant.payments
    .filter((p) => p.status === 'completed' && new Date(p.paymentDate) >= startOfMonth)
    .reduce((s, p) => s + p.amount, 0);
  const outstanding = Math.max(0, rent - paid);
  if (outstanding <= 0) return [];

  const dueDay = getRentDueDay(tenant);
  const dueDate = getDueDateForMonth(now.getFullYear(), now.getMonth(), dueDay);
  const daysUntilDue = daysBetween(now, dueDate);
  const roomLabel = `${tenant.room.roomNumber} at ${tenant.room.property?.name || 'your property'}`;
  const created = [];

  const tenantUser = await prisma.user.findFirst({
    where: { tenantProfileId: tenant.id },
    select: { id: true },
  });

  if (daysUntilDue > UPCOMING_DAYS) return [];

  if (daysUntilDue >= 0 && daysUntilDue <= UPCOMING_DAYS) {
    const daysLabel = daysUntilDue === 0 ? 'today' : `in ${daysUntilDue} day(s)`;
    const msg = `${tenant.name} — rent of ${formatMoney(outstanding)} for ${roomLabel} is due ${daysLabel} (${dueDate.toLocaleDateString()})`;
    if (await createNotificationIfNew(tenant.userId, 'rent_upcoming', 'Rent Due Soon', msg, tenant.name)) {
      created.push('landlord_upcoming');
    }
    if (tenantUser) {
      const tenantMsg = `Your rent of ${formatMoney(outstanding)} for ${roomLabel} is due ${daysLabel} (${dueDate.toLocaleDateString()})`;
      if (await createNotificationIfNew(tenantUser.id, 'rent_upcoming', 'Rent Due Soon', tenantMsg, roomLabel)) {
        created.push('tenant_upcoming');
      }
    }
  } else if (daysUntilDue < 0) {
    const overdueDays = Math.abs(daysUntilDue);
    const msg = `${tenant.name} owes ${formatMoney(outstanding)} for ${roomLabel} — ${overdueDays} day(s) overdue`;
    if (await createNotificationIfNew(tenant.userId, 'rent_due', 'Rent Overdue', msg, tenant.name)) {
      created.push('landlord_overdue');
    }
    if (tenantUser) {
      const tenantMsg = `Your rent of ${formatMoney(outstanding)} for ${roomLabel} is ${overdueDays} day(s) overdue. Please pay as soon as possible.`;
      if (await createNotificationIfNew(tenantUser.id, 'rent_due', 'Rent Overdue', tenantMsg, roomLabel)) {
        created.push('tenant_overdue');
      }
    }
  }

  return created;
}

async function generateRentNotificationsForLandlord(landlordId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const tenants = await prisma.tenant.findMany({
    where: { userId: landlordId, roomId: { not: null } },
    include: {
      room: { include: { property: true } },
      payments: { where: { paymentDate: { gte: startOfMonth } } },
    },
  });

  let count = 0;
  for (const tenant of tenants) {
    const results = await processTenantRent(tenant, now);
    count += results.length;
  }
  return count;
}

async function generateRentNotificationsForTenant(tenantProfileId, tenantUserId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantProfileId },
    include: {
      room: { include: { property: true } },
      payments: { where: { paymentDate: { gte: startOfMonth } } },
    },
  });

  if (!tenant?.roomId) return 0;
  const results = await processTenantRent(tenant, now);
  return results.length;
}

module.exports = {
  generateRentNotificationsForLandlord,
  generateRentNotificationsForTenant,
};
