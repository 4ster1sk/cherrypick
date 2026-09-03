/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class CleanRemoteDriveFiles1788424047171 {
    name = 'CleanRemoteDriveFiles1788424047171';

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        await queryRunner.query('ALTER TABLE "meta" ADD "enableRemoteDriveFilesCleaning" boolean NOT NULL DEFAULT false');
        await queryRunner.query('ALTER TABLE "meta" ADD "remoteDriveFilesCleaningMaxProcessingDurationInMinutes" integer NOT NULL DEFAULT 60');
        await queryRunner.query('ALTER TABLE "meta" ADD "remoteDriveFilesCleaningExpiryDaysForEachFiles" integer NOT NULL DEFAULT 90');
        await queryRunner.query('ALTER TABLE "meta" ADD "remoteDriveFilesCleaningLastCursorId" character varying(32)');
        await queryRunner.query(`COMMENT ON COLUMN "meta"."remoteDriveFilesCleaningLastCursorId" IS 'The resume cursor (drive_file ID) of the remote drive files cleaning. Null means starting from the beginning.'`);
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query(`COMMENT ON COLUMN "meta"."remoteDriveFilesCleaningLastCursorId" IS NULL`);
        await queryRunner.query('ALTER TABLE "meta" DROP COLUMN "remoteDriveFilesCleaningLastCursorId"');
        await queryRunner.query('ALTER TABLE "meta" DROP COLUMN "remoteDriveFilesCleaningExpiryDaysForEachFiles"');
        await queryRunner.query('ALTER TABLE "meta" DROP COLUMN "remoteDriveFilesCleaningMaxProcessingDurationInMinutes"');
        await queryRunner.query('ALTER TABLE "meta" DROP COLUMN "enableRemoteDriveFilesCleaning"');
    }
}
