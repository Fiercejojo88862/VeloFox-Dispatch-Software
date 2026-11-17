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
-- Chauffeurs
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drivers (
    id            varchar(50) PRIMARY KEY,
    display_name  varchar(120) NOT NULL,
    phone         varchar(30),
    status        text NOT NULL DEFAULT 'available',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT drivers_id_check CHECK (btrim(id) <> ''),
    CONSTRAINT drivers_display_name_check CHECK (btrim(display_name) <> ''),
    CONSTRAINT drivers_status_check
        CHECK (status IN ('available', 'assigned', 'off_duty'))
);

COMMENT ON TABLE drivers IS 'Chauffeur identities used to retrieve assigned trip manifests.';

INSERT INTO drivers (id, display_name)
VALUES
    ('VF-1001', 'Marcus Vance'),
    ('VF-1002', 'David Sterling'),
    ('VF-1003', 'Elena Marquez'),
    ('VF-2004', 'Naomi Laurent')
ON CONFLICT (id) DO UPDATE
SET display_name = EXCLUDED.display_name;

-- -----------------------------------------------------------------------------
-- Client and dispatcher accounts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role           text NOT NULL,
    display_name   varchar(120) NOT NULL,
    email          varchar(254) NOT NULL,
    password_salt  varchar(128) NOT NULL,
    password_hash  varchar(256) NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT accounts_role_check CHECK (role IN ('client', 'dispatcher')),
    CONSTRAINT accounts_display_name_check CHECK (btrim(display_name) <> ''),
    CONSTRAINT accounts_email_check CHECK (btrim(email) <> ''),
    CONSTRAINT accounts_role_email_key UNIQUE (role, email)
);

CREATE INDEX IF NOT EXISTS accounts_email_idx ON accounts (email);

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
    driver_id        varchar(50),
    assigned_vehicle varchar(100),
    luggage_notes    varchar(500),
    client_email     varchar(254),
    client_name      varchar(120),
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
        CHECK (status IN (
            'pending', 'confirmed', 'assigned', 'en_route', 'arrived',
            'passenger_aboard', 'completed', 'cancelled'
        )),
    CONSTRAINT bookings_vehicle_id_fkey
        FOREIGN KEY (vehicle_id) REFERENCES vehicles (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,
    CONSTRAINT bookings_driver_id_fkey
        FOREIGN KEY (driver_id) REFERENCES drivers (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);

-- Bring installations created from an earlier schema revision forward safely.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS driver_id varchar(50);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assigned_vehicle varchar(100);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS luggage_notes varchar(500);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_email varchar(254);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_name varchar(120);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
        'pending', 'confirmed', 'assigned', 'en_route', 'arrived',
        'passenger_aboard', 'completed', 'cancelled'
    ));

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_driver_id_fkey;
ALTER TABLE bookings ADD CONSTRAINT bookings_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES drivers (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

COMMENT ON TABLE bookings IS 'Client ride reservations managed from the dispatcher dashboard.';
COMMENT ON COLUMN bookings.pickup_datetime IS 'Scheduled pickup time; stored with time zone.';
COMMENT ON COLUMN bookings.vehicle_type IS 'Requested class; vehicles.category must match once assigned.';
COMMENT ON COLUMN bookings.status IS 'pending | confirmed | assigned | en_route | arrived | passenger_aboard | completed | cancelled.';
COMMENT ON COLUMN bookings.vehicle_id IS 'Fleet vehicle assigned to the ride, or NULL while unassigned.';
COMMENT ON COLUMN bookings.driver_id IS 'Driver ID assigned to the ride and used by the mobile manifest.';
COMMENT ON COLUMN bookings.assigned_vehicle IS 'Human-readable fleet label displayed to the driver.';

CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_pickup_datetime_idx ON bookings (pickup_datetime);
CREATE INDEX IF NOT EXISTS bookings_vehicle_id_idx ON bookings (vehicle_id);
CREATE INDEX IF NOT EXISTS bookings_driver_id_idx ON bookings (driver_id);
CREATE INDEX IF NOT EXISTS bookings_client_email_idx ON bookings (client_email);
CREATE INDEX IF NOT EXISTS bookings_created_at_idx ON bookings (created_at DESC);

-- -----------------------------------------------------------------------------
-- Client ratings and product feedback
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_reviews (
    booking_id    uuid PRIMARY KEY,
    client_email  varchar(254) NOT NULL,
    driver_id     varchar(50),
    rating        smallint NOT NULL,
    feedback      varchar(1000),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT trip_reviews_booking_fkey
        FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT trip_reviews_driver_fkey
        FOREIGN KEY (driver_id) REFERENCES drivers (id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT trip_reviews_rating_check CHECK (rating BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS trip_reviews_driver_idx ON trip_reviews (driver_id);
CREATE INDEX IF NOT EXISTS trip_reviews_client_email_idx ON trip_reviews (client_email);

CREATE TABLE IF NOT EXISTS app_feedback (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_email  varchar(254) NOT NULL,
    category      text NOT NULL,
    message       varchar(2000) NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT app_feedback_category_check
        CHECK (category IN ('experience', 'booking', 'portal', 'other')),
    CONSTRAINT app_feedback_message_check CHECK (btrim(message) <> '')
);

CREATE INDEX IF NOT EXISTS app_feedback_created_at_idx ON app_feedback (created_at DESC);

-- -----------------------------------------------------------------------------
-- Driver telemetry history
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_telemetry (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    driver_id    varchar(50) NOT NULL,
    booking_id   uuid NOT NULL,
    latitude     double precision NOT NULL,
    longitude    double precision NOT NULL,
    accuracy     double precision,
    heading      double precision,
    speed        double precision,
    recorded_at  timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT driver_telemetry_driver_fkey
        FOREIGN KEY (driver_id) REFERENCES drivers (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT driver_telemetry_booking_fkey
        FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT driver_telemetry_latitude_check CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT driver_telemetry_longitude_check CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT driver_telemetry_accuracy_check CHECK (accuracy IS NULL OR accuracy >= 0),
    CONSTRAINT driver_telemetry_heading_check CHECK (heading IS NULL OR heading BETWEEN 0 AND 360),
    CONSTRAINT driver_telemetry_speed_check CHECK (speed IS NULL OR speed >= 0)
);

CREATE INDEX IF NOT EXISTS driver_telemetry_driver_recorded_idx
    ON driver_telemetry (driver_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS driver_telemetry_booking_recorded_idx
    ON driver_telemetry (booking_id, recorded_at DESC);

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

DROP TRIGGER IF EXISTS drivers_set_updated_at ON drivers;
CREATE TRIGGER drivers_set_updated_at
    BEFORE UPDATE ON drivers
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS accounts_set_updated_at ON accounts;
CREATE TRIGGER accounts_set_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trip_reviews_set_updated_at ON trip_reviews;
CREATE TRIGGER trip_reviews_set_updated_at
    BEFORE UPDATE ON trip_reviews
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS bookings_set_updated_at ON bookings;
CREATE TRIGGER bookings_set_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

COMMIT;
