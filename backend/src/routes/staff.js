const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware, requireRole('admin'));

router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    const staff = await prisma.user.findMany({
      where: {
        role: 'maintenance',
        landlordId: req.user.id,
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
      select: { id: true, name: true, email: true, phone: true, username: true, createdAt: true },
      orderBy: { name: 'asc' },
    });
    res.json(staff);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { username, email, password, name, phone } = req.body;
    if (!username || !email || !password || !name) {
      return res.status(400).json({ error: 'Username, email, password, and name are required' });
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const staff = await prisma.user.create({
      data: {
        username,
        email,
        password: hashed,
        name,
        phone,
        role: 'maintenance',
        landlordId: req.user.id,
      },
      select: { id: true, name: true, email: true, phone: true, username: true },
    });

    res.status(201).json(staff);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
