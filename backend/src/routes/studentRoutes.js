'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  registerStudent,
  getAllStudents,
  getStudent,
  getPaymentSummary,
  bulkImportStudents,
} = require('../controllers/studentController');
const { validateRegisterStudent, validateStudentIdParam } = require('../middleware/validate');
const { resolveSchool } = require('../middleware/schoolContext');

// Multer configured for in-memory CSV uploads (max 5 MB)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// All student routes require school context
router.use(resolveSchool);

router.post('/',          validateRegisterStudent, registerStudent);
router.post('/bulk',      upload.single('file'),   bulkImportStudents);
router.get('/summary',    getPaymentSummary);
router.get('/',           getAllStudents);
router.get('/:studentId', validateStudentIdParam,  getStudent);

module.exports = router;
