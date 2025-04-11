import { Context } from 'hono';

import { CONSTANTS } from '../constants';
import { getJsonSetting, saveSetting, checkUserPassword, getDomains, getUserRoles } from '../utils';
import { UserSettings, GeoData, UserInfo } from "../models";
import { handleListQuery } from '../common'
import { HonoCustomType } from '../types';

export default {
    getSetting: async (c: Context<HonoCustomType>) => {
        const value = await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY);
        const settings = new UserSettings(value);
        return c.json(settings)
    },
    saveSetting: async (c: Context<HonoCustomType>) => {
        const value = await c.req.json();
        const settings = new UserSettings(value);
        if (settings.enableMailVerify && !c.env.KV) {
            return c.text("Please enable KV first if you want to enable mail verify", 403)
        }
        if (settings.enableMailVerify && !settings.verifyMailSender) {
            return c.text("Please provide verifyMailSender", 400)
        }
        if (settings.enableMailVerify && settings.verifyMailSender) {
            const mailDomain = settings.verifyMailSender.split("@")[1];
            const domains = getDomains(c);
            if (!domains.includes(mailDomain)) {
                return c.text(`VerifyMailSender(${settings.verifyMailSender}) domain must in ${JSON.stringify(domains, null, 2)}`, 400)
            }
        }
        if (settings.maxAddressCount < 0) {
            return c.text("Invalid maxAddressCount", 400)
        }
        await saveSetting(c, CONSTANTS.USER_SETTINGS_KEY, JSON.stringify(settings));
        return c.json({ success: true })
    },
    getUsers: async (c: Context<HonoCustomType>) => {
        const { limit, offset, query } = c.req.query();
        if (query) {
            return await handleListQuery(c,
                `SELECT u.id as id, u.user_email, u.created_at, u.updated_at,`
                + ` ur.role_text as role_text,`
                + ` (SELECT COUNT(*) FROM users_address WHERE user_id = u.id) AS address_count`
                + ` FROM users u`
                + ` LEFT JOIN user_roles ur ON u.id = ur.user_id`
                + ` where u.user_email like ?`,
                `SELECT count(*) as count FROM users where user_email like ?`,
                [`%${query}%`], limit, offset
            );
        }
        return await handleListQuery(c,
            `SELECT u.id as id, u.user_email, u.created_at, u.updated_at,`
            + ` ur.role_text as role_text,`
            + ` (SELECT COUNT(*) FROM users_address WHERE user_id = u.id) AS address_count`
            + ` FROM users u`
            + ` LEFT JOIN user_roles ur ON u.id = ur.user_id`,
            `SELECT count(*) as count FROM users`,
            [], limit, offset
        );
    },
    createUser: async (c: Context<HonoCustomType>) => {
        const { email, password } = await c.req.json();
        if (!email || !password) {
            return c.text("Invalid email or password", 400)
        }
        // geo data
        const reqIp = c.req.raw.headers.get("cf-connecting-ip")
        const geoData = new GeoData(reqIp, c.req.raw.cf as any);
        const userInfo = new UserInfo(geoData, email);
        try {
            checkUserPassword(password);
            const { success } = await c.env.DB.prepare(
                `INSERT INTO users (user_email, password, user_info)`
                + ` VALUES (?, ?, ?)`
            ).bind(
                email, password, JSON.stringify(userInfo)
            ).run();
            if (!success) {
                return c.text("Failed to register", 500)
            }
        } catch (e) {
            const errorMsg = (e as Error).message;
            if (errorMsg && errorMsg.includes("UNIQUE")) {
                return c.text("User already exists", 400)
            }
            return c.text(`Failed to register: ${errorMsg}`, 500)
        }
        return c.json({ success: true })
    },
    deleteUser: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.req.param();
        if (!user_id) return c.text("Invalid user_id", 400);
        const { success } = await c.env.DB.prepare(
            `DELETE FROM users WHERE id = ?`
        ).bind(user_id).run();
        const { success: addressSuccess } = await c.env.DB.prepare(
            `DELETE FROM users_address WHERE user_id = ?`
        ).bind(user_id).run();
        if (!success || !addressSuccess) {
            return c.text("Failed to delete user", 500)
        }
        return c.json({ success: true })
    },
    resetPassword: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.req.param();
        const { password } = await c.req.json();
        if (!user_id) return c.text("Invalid user_id", 400);
        try {
            checkUserPassword(password);
            const { success } = await c.env.DB.prepare(
                `UPDATE users SET password = ? WHERE id = ?`
            ).bind(password, user_id).run();
            if (!success) {
                return c.text("Failed to reset password", 500)
            }
        } catch (e) {
            return c.text(`Failed to reset password: ${(e as Error).message}`, 500)
        }
        return c.json({ success: true });
    },
    updateUserRoles: async (c: Context<HonoCustomType>) => {
        const { user_id, role_text } = await c.req.json();
        if (!user_id) return c.text("Invalid user_id", 400);
        if (!role_text) {
            const { success } = await c.env.DB.prepare(
                `DELETE FROM user_roles WHERE user_id = ?`
            ).bind(user_id).run();
            if (!success) {
                return c.text("Failed to update user roles", 500)
            }
            return c.json({ success: true })
        }
        const user_roles = getUserRoles(c);
        if (!user_roles.find((r) => r.role === role_text)) {
            return c.text("Invalid role_text", 400)
        }
        const { success } = await c.env.DB.prepare(
            `INSERT INTO user_roles (user_id, role_text)`
            + ` VALUES (?, ?)`
            + ` ON CONFLICT(user_id) DO UPDATE SET role_text = ?, updated_at = datetime('now')`
        ).bind(user_id, role_text, role_text).run();
        if (!success) {
            return c.text("Failed to update user roles", 500)
        }
        return c.json({ success: true })
    },
    getBindedAddresses: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.req.param();
        if (!user_id) return c.text("Invalid user_id", 400);
        // select binded address
        const { results } = await c.env.DB.prepare(
            `SELECT a.*,`
            + ` (SELECT COUNT(*) FROM raw_mails WHERE address = a.name) AS mail_count,`
            + ` (SELECT COUNT(*) FROM sendbox WHERE address = a.name) AS send_count`
            + ` FROM address a `
            + ` JOIN users_address ua `
            + ` ON ua.address_id = a.id `
            + ` WHERE ua.user_id = ?`
            + ` ORDER BY a.id DESC`
        ).bind(user_id).all();
        return c.json({
            results: results,
        })
    },
}
