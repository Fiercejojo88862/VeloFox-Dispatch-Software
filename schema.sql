-- =============================================================================
-- VeloFox Dispatch Software — PostgreSQL schema
-- -----------------------------------------------------------------------------
-- Apply with:
--   psql "$DATABASE_URL" -f schema.sql
--
-- Safe to re-run: every object is created only when it does not already exist.
-- Requires PostgreSQL 13+ (gen_random_uuid() is built in).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Fleet inventory
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicles (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category      text NOT NULL,
    license_plate varchar(16) NOT NULL,
    status        text NOT NULL DEFAULT 'available',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vehicles_category_check
        CHECK (category IN ('sedan', 'suv', 'sprinter', 'limousine')),
    CONSTRAINT vehicles_license_plate_check
        CHECK (btrim(license_plate) <> ''),
    CONSTRAINT vehicles_license_plate_key
        UNIQUE (license_plate),
    CONSTRAINT vehicles_status_check
        CHECK (status IN ('available', 'assigned', 'maintenance', 'out_of_service'))
);

COMMENT ON TABLE vehicles IS 'Fleet vehicles available for dispatcher assignment.';
COMMENT ON COLUMN vehicles.id IS 'Surrogate primary key referenced by bookings.vehicle_id.';
COMMENT ON COLUMN vehicles.category IS 'Vehicle class: sedan | suv | sprinter | limousine.';
COMMENT ON COLUMN vehicles.license_plate IS 'Registration plate; unique across the fleet.';
COMMENT ON COLUMN vehicles.status IS 'available | assigned | maintenance | out_of_service.';

CREATE INDEX IF NOT EXISTS vehicles_status_idx ON vehicles (status);
CREATE INDEX IF NOT EXISTS vehicles_category_idx ON vehicles (category);

-- -----------------------------------------------------------------------------
-- Reservations
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pickup_location  varchar(200) NOT NULL,
    dropoff_location varchar(200) NOT NULL,
    pickup_datetime  timestamptz NOT NULL,
    vehicle_type     text NOT NULL,
    passenger_count  smallint NOT NULL,
    status           text NOT NULL DEFAULT 'pending',
    vehicle_id       uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT bookings_pickup_location_check
        CHECK (btrim(pickup_location) <> ''),
    CONSTRAINT bookings_dropoff_location_check
        CHECK (btrim(dropoff_location) <> ''),
    CONSTRAINT bookings_vehicle_type_check
        CHECK (vehicle_type IN ('sedan', 'suv', 'sprinter', 'limousine')),
    CONSTRAINT bookings_passenger_count_check
        CHECK (passenger_count BETWEEN 1 AND 14),
    CONSTRAINT bookings_status_check
        CHECK (status IN ('pending', 'confirmed', 'assigned', 'completed', 'cancelled')),
    CONSTRAINT bookings_vehicle_id_fkey
        FOREIGN KEY (vehicle_id) REFERENCES vehicles (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);

COMMENT ON TABLE bookings IS 'Client ride reservations managed from the dispatcher dashboard.';
COMMENT ON COLUMN bookings.pickup_datetime IS 'Scheduled pickup time; stored with time zone.';
COMMENT ON COLUMN bookings.vehicle_type IS 'Requested class; vehicles.category must match once assigned.';
COMMENT ON COLUMN bookings.status IS 'pending | confirmed | assigned | completed | cancelled.';
COMMENT ON COLUMN bookings.vehicle_id IS 'Fleet vehicle assigned to the ride, or NULL while unassigned.';

CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_pickup_datetime_idx ON bookings (pickup_datetime);
CREATE INDEX IF NOT EXISTS bookings_vehicle_id_idx ON bookings (vehicle_id);
CREATE INDEX IF NOT EXISTS bookings_created_at_idx ON bookings (created_at DESC);

-- -----------------------------------------------------------------------------
-- Keep updated_at current on every row change
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vehicles_set_updated_at ON vehicles;
CREATE TRIGGER vehicles_set_updated_at
    BEFORE UPDATE ON vehicles
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS bookings_set_updated_at ON bookings;
CREATE TRIGGER bookings_set_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

COMMIT;
