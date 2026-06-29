const asyncHandler = require('../utils/asyncHandler');
const payoutService = require('../services/payoutService');
const { toRupees } = require('../utils/money');

exports.request = asyncHandler(async (req, res) => {
  const data = await payoutService.requestWithdrawal({
    astrologerUserId: req.user._id,
    amount: toRupees(req.body.amountRupees),
    bankAccountDetails: req.body.bankAccountDetails,
  });
  res.status(201).json({ success: true, data });
});

exports.listMine = asyncHandler(async (req, res) => {
  const data = await payoutService.listMine(req.user._id);
  res.json({ success: true, data });
});
