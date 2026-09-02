const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authMiddleware, requireRole } = require('../middleware/auth');
const {
  MAINTENANCE_STATUSES,
  notifyMaintenanceParties,
  notifyAllLandlordCrew,
  validateLandlordStaff,
  generateReceiptNumber,
  generateTransactionRef,
} = require('../lib/helpers');
const { generateRentNotificationsForTenant } = require('../lib/rent-notifications');
const { formatMoney } = require('../lib/currency');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware, requireRole('tenant'));

async function getTenantProfile(user) {
  if (!user.tenantProfileId) throw new Error('Tenant profile not linked to this account');
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantProfileId },
    include: { room: { include: { property: true } } },
  });
  if (!tenant || tenant.userId !== user.landlordId) {
    throw new Error('Tenant profile not found');
  }
  return tenant;
}

router.get('/dashboard', async (req, res) => {
  try {
    await generateRentNotificationsForTenant(req.user.tenantProfileId, req.user.id);
    const tenant = await getTenantProfile(req.user);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [payments, maintenance, monthlyPaid] = await Promise.all([
      prisma.payment.findMany({
        where: { tenantId: tenant.id },
        orderBy: { paymentDate: 'desc' },
        take: 5,
      }),
      prisma.maintenanceRequest.findMany({
        where: { tenantId: tenant.id },
        include: { property: true, assignedTo: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      prisma.payment.aggregate({
        where: { tenantId: tenant.id, paymentDate: { gte: startOfMonth }, status: 'completed' },
        _sum: { amount: true },
      }),
    ]);

    const monthlyRent = tenant.room?.rentAmount || 0;
    const paid = monthlyPaid._sum.amount || 0;

    res.json({
      tenant,
      monthlyRent,
      paidThisMonth: paid,
      outstanding: Math.max(0, monthlyRent - paid),
      recentPayments: payments,
      recentMaintenance: maintenance,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/payments', async (req, res) => {
  try {
    const tenant = await getTenantProfile(req.user);
    const payments = await prisma.payment.findMany({
      where: { tenantId: tenant.id },
      orderBy: { paymentDate: 'desc' },
    });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/payments/pay', async (req, res) => {
  try {
    const tenant = await getTenantProfile(req.user);
    const { amount, method } = req.body;
    const payAmount = parseFloat(amount);

    if (!payAmount || payAmount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthlyRent = tenant.room?.rentAmount || 0;

    const paidAgg = await prisma.payment.aggregate({
      where: { tenantId: tenant.id, paymentDate: { gte: startOfMonth }, status: 'completed' },
      _sum: { amount: true },
    });
    const outstanding = Math.max(0, monthlyRent - (paidAgg._sum.amount || 0));

    if (payAmount > outstanding) {
      return res.status(400).json({ error: `Amount exceeds outstanding balance of ${formatMoney(outstanding)}` });
    }

    const transactionRef = generateTransactionRef();
    const payment = await prisma.payment.create({
      data: {
        tenantId: tenant.id,
        amount: payAmount,
        method: method || 'app_card',
        status: 'completed',
        transactionRef,
        receiptNumber: generateReceiptNumber(),
        notes: 'In-app payment (simulated)',
      },
      include: { tenant: { include: { room: { include: { property: true } } } } },
    });

    await notifyMaintenanceParties({
      landlordId: tenant.userId,
      title: 'Rent Payment Received',
      message: `${tenant.name} paid ${formatMoney(payAmount)} via app`,
    });

    res.status(201).json({
      payment,
      message: 'Payment successful',
      simulated: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/payments/:id/receipt', async (req, res) => {
  try {
    const tenant = await getTenantProfile(req.user);
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id, tenantId: tenant.id },
      include: { tenant: { include: { room: { include: { property: true } } } } },
    });
    if (!payment) return res.status(404).json({ error: 'Receipt not found' });
    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/crew', async (req, res) => {
  try {
    const { search } = req.query;
    const landlordId = req.user.landlordId;
    if (!landlordId) return res.json([]);

    const crew = await prisma.user.findMany({
      where: {
        role: 'maintenance',
        landlordId,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { username: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { id: true, name: true, email: true, phone: true, username: true },
      orderBy: { name: 'asc' },
      take: 20,
    });
    res.json(crew);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/maintenance', async (req, res) => {
  try {
    const tenant = await getTenantProfile(req.user);
    const requests = await prisma.maintenanceRequest.findMany({
      where: { tenantId: tenant.id },
      include: {
        property: true,
        assignedTo: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/maintenance', async (req, res) => {
  try {
    const tenant = await getTenantProfile(req.user);
    const { title, description, priority, assignmentMode, assignedToId } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }
    if (!tenant.room?.propertyId) {
      return res.status(400).json({ error: 'No unit assigned to your account' });
    }

    const mode = assignmentMode === 'selected' ? 'selected' : 'open';
    let staffId = null;

    if (mode === 'selected') {
      if (!assignedToId) {
        return res.status(400).json({ error: 'Please select a maintenance crew member' });
      }
      const staff = await validateLandlordStaff(tenant.userId, assignedToId);
      if (!staff) return res.status(404).json({ error: 'Selected crew member not found' });
      staffId = staff.id;
    }

    const request = await prisma.maintenanceRequest.create({
      data: {
        title,
        description,
        priority: priority || 'medium',
        propertyId: tenant.room.propertyId,
        tenantId: tenant.id,
        requestedBy: 'tenant',
        assignmentMode: mode,
        assignedToId: staffId,
        claimedAt: staffId ? new Date() : null,
        status: 'pending',
      },
      include: { property: true, assignedTo: { select: { id: true, name: true } } },
    });

    await notifyMaintenanceParties({
      landlordId: tenant.userId,
      title: 'New Tenant Maintenance Request',
      message: `${tenant.name}: ${title}`,
    });

    if (mode === 'open') {
      await notifyAllLandlordCrew(
        tenant.userId,
        'Open Maintenance Job',
        `First come, first serve: ${title}`
      );
    } else if (staffId) {
      await notifyMaintenanceParties({
        staffUserId: staffId,
        title: 'Maintenance Job Assigned',
        message: `You were selected for: ${title}`,
      });
    }

    res.status(201).json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
