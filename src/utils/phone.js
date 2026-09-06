export function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

export function validatePhoneNumber(value) {
  const phone = normalizePhone(value);
  if (!/^\d{8,15}$/.test(phone)) {
    return { valid: false, reason: 'Use 8–15 digits with the country code and no +, spaces, or symbols.' };
  }
  return { valid: true, phone };
}

export function formatPairingCode(code) {
  const clean = String(code || '').replace(/\s/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
