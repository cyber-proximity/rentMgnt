const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const propertyRoutes = require('./routes/properties');
const tenantRoutes = require('./routes/tenants');
const paymentRoutes = require('./routes/payments');
const maintenanceRoutes = require('./routes/maintenance');
const dashboardRoutes = require('./routes/dashboard');
const notificationRoutes = require('./routes/notifications');
const reportRoutes = require('./routes/reports');
const mapRoutes = require('./routes/map');
const listingsRoutes = require('./routes/listings');
const bookingsRoutes = require('./routes/bookings');
const tenantPortalRoutes = require('./routes/tenant-portal');
const staffPortalRoutes = require('./routes/staff-portal');
const staffRoutes = require('./routes/staff');
const uploadRoutes = require('./routes/uploads');
const { UPLOAD_DIR } = require('./lib/upload');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

// Temporary diagnostic route — reveals only the DB host/name (never
// credentials) plus a data fingerprint, to confirm which database this
// deployed instance is actually bound to. Remove after use.
app.get('/api/_debug/db-info', async (_req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    let host = 'unknown';
    try {
      const u = new URL(process.env.DATABASE_URL || '');
      host = u.host + u.pathname;
    } catch {}
    const userCount = await prisma.user.count();
    const admin = await prisma.user.findUnique({ where: { username: 'admin' } });
    const probe = await prisma.user.findFirst({ where: { username: { startsWith: 'probe_' } } });
    await prisma.$disconnect();
    res.json({
      host,
      userCount,
      adminId: admin?.id || null,
      adminUpdatedAt: admin?.updatedAt || null,
      probeFound: !!probe,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/map', mapRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/tenant-portal', tenantPortalRoutes);
app.use('/api/staff-portal', staffPortalRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/uploads', uploadRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Rent Management API running on http://0.0.0.0:${PORT}`);
});
