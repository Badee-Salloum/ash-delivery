-- The number painted on the bike — «الرقم التمييزي على الأرض».
--
-- A vehicle already carries two identifiers and neither is the one a driver can read in the yard:
--   * `code` is «governorate-branch-type-machine», derived by `formatVehicleNumber` from where the
--     bike sits in the fleet. It is correct, it is unique, and it changes meaning if the bike moves
--     branch. Nobody paints it on a mudguard.
--   * `plate_no` is the licence plate: a legal identifier, often absent on an electric motorbike in
--     Damascus, and not what the branch uses to tell ten identical bikes apart.
--
-- The ground number is what the fleet actually marks the machines with, and it is what a driver is
-- told when he is sent to take «rakm arba'a». Until now his screen offered him «الآلية 1-1-1-4» and
-- he had to hold the mapping in his head, which is how the wrong bike gets taken out — and the
-- odometer, the battery and the whole start package then belong to a machine nobody rode.
--
-- Nullable on purpose. A fleet that has not painted its bikes yet must not be blocked from
-- recording them, and a bike whose marking has worn off is honestly described by NULL rather than
-- by a number somebody guessed. Deliberately NOT unique: it is a human marking, the branch owns its
-- own numbering, and a uniqueness error at the moment a manager records a real bike would teach him
-- to type something false to get past it. `code` remains the identity the system reasons about.

ALTER TABLE vehicles ADD COLUMN ground_no text;

COMMENT ON COLUMN vehicles.ground_no IS
  'The number physically marked on the vehicle, as a driver reads it in the yard. Human-facing identification only — never an identity the system joins or reasons on; that is `code`.';

-- And the same for a battery pack, for the same reason and more urgently.
--
-- A pack is identified today by `serial_no` and `bms_mac`, both of which come off the BMS phone app:
-- long, transcribed by OCR, and readable only by pairing to the pack over Bluetooth. Neither helps
-- a man holding two packs at a charging shelf. Packs are the expensive consumable, they move between
-- machines, and a swap recorded against the wrong pack puts the wrong battery's history on the wrong
-- asset — so the physical marking is the identifier that has to be on the screen.
ALTER TABLE batteries ADD COLUMN ground_no text;

COMMENT ON COLUMN batteries.ground_no IS
  'The number physically marked on the pack, as staff read it at the shelf. Human-facing identification only; `serial_no`/`bms_mac` remain what the BMS reading is tied to.';
